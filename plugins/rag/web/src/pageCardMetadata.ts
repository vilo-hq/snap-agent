import * as cheerio from 'cheerio';

/**
 * What a page SAYS about itself, plus its presentation. No verdict on what it IS.
 *
 * WHY: this module used to sort every page into nine roles (`detail | listing | amenity | promotion |
 * contact | content | blog | system | page`) and derive `cardEligible` and `cardPriority` from them.
 * Three problems, measured against a real corpus:
 *
 * 1. The vocabulary is a storefront's. `promotion` classified 2 chunks across an entire tenant;
 *    `content` and `blog`, zero. Meanwhile `hardExcludePage` sent EVERY news page to `system`,
 *    assuming `/news/` is shop chrome — on a content site, news IS the content.
 * 2. The verdict was lossy. `inferTypeFromUrl` tried twenty patterns (`/projects/`, `/people/`,
 *    `/propiedad/`…) with `.some()` and returned `detail`: it knew WHICH one matched and threw that
 *    away. The host ended up rediscovering it with the same regexes, duplicated on its side.
 * 3. And it was un-overridable. `type` was simultaneously the role, the eligibility key and a
 *    filterable field, so the host could not correct it without silently turning cards off. It
 *    repaired afterwards instead, with backfill scripts.
 *
 * Now we emit the EVIDENCE — the JSON-LD `@type` verbatim, `og:type`, the path segments, which
 * signals are present — and the caller decides, because the caller knows its vertical. The most
 * reliable fact on a page is what the site itself declares; flattening it to `detail` destroyed it.
 *
 * The opinions worth keeping ship as exported constants (`DEFAULT_JUNK_URL_PATTERNS`,
 * `STOREFRONT_URL_PATTERNS`): the caller uses them, extends them, or ignores them. We share the
 * knowledge without imposing it.
 */

/** Presence signals. Facts, not judgements. */
export interface PageSignals {
  hasPrice: boolean;
  hasPublishDate: boolean;
  hasAuthor: boolean;
  hasH1: boolean;
}

export interface PageObservations {
  /** Each JSON-LD node's `@type`, lowercased and stripped of the vocabulary URL. UNMAPPED. */
  schemaTypes: string[];
  /** `og:type`, verbatim. */
  ogType?: string;
  /** Path segments, lowercased, empties dropped: `/our-work/projects/x` → [our-work, projects, x] */
  pathSegments: string[];
  signals: PageSignals;
}

export interface PageDisplayMetadataInput {
  url: string;
  title?: string;
  /** `h1` — preferred over `<title>` for the display title. */
  headingTitle?: string;
  description?: string;
  imageUrl?: string;
  html?: string;
  /** Price signal already detected by the caller (product extractors). */
  hasPriceSignal?: boolean;
}

export interface PageDisplayMetadataResult {
  displayTitle?: string;
  displayDescription?: string;
  displayImageUrl?: string;
  observations: PageObservations;
}

/**
 * Pages that are not content in any vertical: auth, cart, admin, errors.
 *
 * EXPORTED, not applied: the caller decides whether to skip them. Filtering them saves embeddings
 * and keeps junk out of retrieval, so most callers will want them — but it stays their call.
 *
 * Note what is NOT here: `news`, `press`, `article`, `blog`, `tag`, `category`, `author`, `archive`
 * and `careers` were all in the previous list, and it was always applied. That assumed a storefront.
 * For an architecture firm or a publisher those pages are the product, and undoing the exclusion
 * cost one backfill script per class.
 */
export const DEFAULT_JUNK_URL_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:login|signin|sign-in|signup|sign-up|register|account)(?:\/|$|-|\.)/i,
  /(?:^|\/)(?:cart|checkout|thank|gracias|confirm|success|receipt)(?:\/|$|-|\.)/i,
  /(?:^|\/)(?:admin|wp-admin)(?:\/|$|-|\.)/i,
  /(?:^|\/)(?:privacy|terms|legal|cookies|gdpr)(?:\/|$|-|\.)/i,
  /(?:^|\/)404(?:\/|$|-|\.)/i,
];

/** Titles that give away a utility page when the URL does not. Exported, not applied. */
export const DEFAULT_JUNK_TITLE_PATTERNS: readonly RegExp[] = [
  /\b(?:login|sign\s*in|sign\s*up|privacy\s*policy|terms\s*(?:of\s*)?service|thank\s*you|gracias\s*por|admin|404|not\s*found)\b/i,
];

/** Retail patterns: they only make sense on a storefront, so THAT caller opts in. */
export const STOREFRONT_URL_PATTERNS = {
  promotion: [
    /(?:^|\/)(?:offer|offers|sale|sales|promo|promotion|deal|deals|coupon|special-offer|buster)(?:\/|$|-|\.)/i,
    /(?:^|\/)[^/]*(?:-sale|-offer|-promo|-deal|-buster)(?:\/|$)/i,
  ] as readonly RegExp[],
  cartAndCheckout: [/(?:^|\/)(?:cart|checkout)(?:\/|$|-|\.)/i] as readonly RegExp[],
} as const;

/** Does any pattern match? So the caller does not reimplement the loop. */
export function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(value));
}

const EN_DASH_SUFFIX_RE = /\s+[–—]\s+.+$/;
const PIPE_SUFFIX_RE = /\s+\|\s+.+$/;

/**
 * "Riverside Medical Center | Example Studio" → "Riverside Medical Center".
 *
 * The minimum indices stop a short leading segment from being eaten when the separator comes early,
 * and the two passes cover "Title – Section | Brand". Unchanged from the previous version.
 */
export function normalizeDisplayTitle(title?: string): string | undefined {
  if (!title?.trim()) return title;
  let t = title.trim();
  for (let i = 0; i < 2; i++) {
    const dash = t.match(EN_DASH_SUFFIX_RE);
    if (dash && dash.index !== undefined && dash.index >= 4) {
      t = t.slice(0, dash.index).trim();
      continue;
    }
    const pipe = t.match(PIPE_SUFFIX_RE);
    if (pipe && pipe.index !== undefined && pipe.index >= 8) {
      t = t.slice(0, pipe.index).trim();
      continue;
    }
    break;
  }
  return t || title.trim();
}

function collectJsonLdNodes(data: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    nodes.push(obj);
    if (obj['@graph']) visit(obj['@graph']);
  };
  visit(data);
  return nodes;
}

function schemaTypeNames(node: Record<string, unknown>): string[] {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : type != null ? [type] : [];
  return types
    .map((raw) => {
      const s = String(raw).toLowerCase();
      const slash = s.lastIndexOf('/');
      return slash >= 0 ? s.slice(slash + 1) : s;
    })
    .filter(Boolean);
}

/**
 * The `@type` values the page declares, verbatim and unmapped.
 *
 * This used to run through a `SCHEMA_TYPE_MAP` that collapsed `Person`, `Article`, `Event` and
 * `Course` into `detail`. The site said `Person` — the most reliable signal on the page — and
 * flattening it forced the host to rediscover the class from the URL.
 */
export function extractSchemaTypes(html: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).html()?.trim();
    if (!raw) continue;
    try {
      for (const node of collectJsonLdNodes(JSON.parse(raw) as unknown)) {
        for (const name of schemaTypeNames(node)) out.add(name);
        // `offers` without a readable `@type` is still a commercial-offer signal.
        if (node.offers != null) out.add('offer');
      }
    } catch {
      /* one broken JSON-LD block does not invalidate the others */
    }
  }
  return [...out];
}

export function extractPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return [];
  }
}

/** Presentation + evidence. No `type`, no `cardEligible`, no `cardPriority`. */
export function resolvePageDisplayMetadata(
  input: PageDisplayMetadataInput,
): PageDisplayMetadataResult {
  const html = input.html ?? '';
  const $ = html ? cheerio.load(html) : null;
  const heading = input.headingTitle?.trim();

  const observations: PageObservations = {
    schemaTypes: html ? extractSchemaTypes(html) : [],
    ogType: $ ? $('meta[property="og:type"]').attr('content')?.toLowerCase() || undefined : undefined,
    pathSegments: extractPathSegments(input.url),
    signals: {
      hasPrice: input.hasPriceSignal === true,
      hasPublishDate: $
        ? $('meta[property="article:published_time"], time[datetime]').length > 0
        : false,
      hasAuthor: $ ? $('meta[name="author"], meta[property="article:author"]').length > 0 : false,
      hasH1: heading != null && heading.length > 0,
    },
  };

  return {
    displayTitle: normalizeDisplayTitle(heading || input.title),
    displayDescription: input.description?.trim() || undefined,
    displayImageUrl: input.imageUrl,
    observations,
  };
}
