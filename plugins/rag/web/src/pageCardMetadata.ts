import * as cheerio from 'cheerio';

/** Abstract page roles — vertical-agnostic. */
export type PageCardType =
  | 'detail'
  | 'listing'
  | 'amenity'
  | 'promotion'
  | 'contact'
  | 'content'
  | 'blog'
  | 'system'
  | 'page';

export interface PageCardMetadataInput {
  url: string;
  title?: string;
  /** Primary heading (h1) — preferred for displayTitle over the document title tag. */
  headingTitle?: string;
  description?: string;
  imageUrl?: string;
  html?: string;
  /** Type already resolved from typeFromUrl / defaultType. */
  type?: string;
  hasProductPrice?: boolean;
}

export interface PageCardMetadataResult {
  type: PageCardType | string;
  cardEligible: boolean;
  cardPriority: number;
  displayTitle?: string;
  displayDescription?: string;
  displayImageUrl?: string;
}

const HARD_EXCLUDE_URL_RE =
  /(?:^|\/)(?:login|signin|sign-in|signup|sign-up|register|account|cart|checkout|admin|wp-admin|privacy|terms|legal|cookies|gdpr|thank|gracias|confirm|success|receipt|404|tag|tags|category|categories|author|archive|newsletter|careers|jobs)(?:\/|$|-|\.)/i;

const HARD_EXCLUDE_TITLE_RE =
  /\b(?:login|sign\s*in|sign\s*up|privacy\s*policy|terms\s*(?:of\s*)?service|thank\s*you|gracias\s*por|admin|404|not\s*found)\b/i;

const BLOG_URL_RE = /(?:^|\/)(?:blog|news|press|article|posts?)(?:\/|$)/i;

const PROMOTION_URL_RE =
  /(?:^|\/)(?:offer|offers|sale|sales|promo|promotion|deal|deals|coupon|special-offer|buster)(?:\/|$|-|\.)/i;
/** Slug contains promo tokens without a path segment (e.g. inflation-buster-sale). */
const PROMOTION_SLUG_RE = /(?:^|\/)[^/]*(?:-sale|-offer|-promo|-deal|-buster)(?:\/|$)/i;

/** Path has a segment after a known collection slug → entity detail (e.g. /projects/acme-tower). */
const ENTITY_DETAIL_PATH_RES: RegExp[] = [
  /\/projects\/[^/]+/i,
  /\/project\/[^/]+/i,
  /\/perspectives\/[^/]+/i,
  /\/perspective\/[^/]+/i,
  /\/portfolio\/[^/]+/i,
  /\/case-stud(?:y|ies)\/[^/]+/i,
  /\/insights?\/[^/]+/i,
  /\/people\/[^/]+/i,
  /\/person\/[^/]+/i,
  /\/team-members?\/[^/]+/i,
  /\/members?\/[^/]+/i,
  /\/staff\/[^/]+/i,
  /\/experts?\/[^/]+/i,
  /\/authors?\/[^/]+/i,
  /\/leadership\/[^/]+/i,
  /\/biograph(?:y|ies)\/[^/]+/i,
  /\/propiedad\/[^/]+/i,
  /\/propiedades\/[^/]+/i,
  /\/listings\/[^/]+/i,
  /\/propiedades\/clasificado\/[^/]+/i,
];

const DETAIL_URL_RE =
  /(?:^|\/)(?:product|products|item|items|p|room|rooms|suite|suites|habitacion|plan|plans|space|spaces|tour|tours|menu|project|perspective|person|team-member|team-members|staff|expert|case-study|author|biography|propiedad|propiedades|inmueble|inmuebles|listings)(?:\/|$)/i;

/** Argenprop-style slug: departamento-en-venta-...--12345678 */
const ARGENPROP_DETAIL_RE =
  /-(?:en-venta|en-alquiler)-[^/?#]+(?:--|\-)\d{5,}/i;

const LISTING_URL_RE =
  /(?:^|\/)(?:catalog|catalogue|collection|collections|category|categories|shop|store|habitaciones|rooms|products|projects|perspectives|portfolio|people|team|members|insights|case-studies|thought-leadership)(?:\/|$)/i;

const AMENITY_URL_RE = /(?:^|\/)(?:amenity|amenities|activity|activities|experience|experiences|service-page)(?:\/|$)/i;

const CONTACT_URL_RE = /(?:^|\/)(?:contact|contacto|about|nosotros|faq|help|support)(?:\/|$)/i;

const EN_DASH_SUFFIX_RE = /\s+[–—]\s+.+$/;
const PIPE_SUFFIX_RE = /\s+\|\s+.+$/;

const CARD_PRIORITY: Record<string, number> = {
  detail: 10,
  listing: 6,
  amenity: 5,
  promotion: 2,
  contact: 1,
  content: 1,
  blog: 0,
  system: 0,
  page: 3,
};

const CARD_ELIGIBLE_DEFAULT: Record<string, boolean> = {
  detail: true,
  listing: true,
  amenity: true,
  promotion: false,
  contact: false,
  content: false,
  blog: false,
  system: false,
  page: false,
};

const SCHEMA_TYPE_MAP: Record<string, PageCardType> = {
  product: 'detail',
  service: 'amenity',
  hotelroom: 'detail',
  room: 'detail',
  apartment: 'detail',
  lodgingroom: 'detail',
  course: 'detail',
  event: 'detail',
  offer: 'promotion',
  person: 'detail',
  employee: 'detail',
  profilepage: 'detail',
  article: 'detail',
  newsarticle: 'detail',
  blogposting: 'detail',
  creativework: 'detail',
};

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

export function hardExcludePage(url: string, title?: string): boolean {
  const path = url.toLowerCase();
  if (HARD_EXCLUDE_URL_RE.test(path)) return true;
  if (BLOG_URL_RE.test(path)) return true;
  if (title && HARD_EXCLUDE_TITLE_RE.test(title.toLowerCase())) return true;
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function inferTypeFromUrl(url: string): PageCardType | undefined {
  const path = url.toLowerCase();
  if (PROMOTION_URL_RE.test(path) || PROMOTION_SLUG_RE.test(path)) return 'promotion';
  if (CONTACT_URL_RE.test(path)) return 'contact';
  if (ENTITY_DETAIL_PATH_RES.some((re) => re.test(path))) return 'detail';
  if (AMENITY_URL_RE.test(path)) return 'amenity';
  if (DETAIL_URL_RE.test(path)) return 'detail';
  if (ARGENPROP_DETAIL_RE.test(path)) return 'detail';
  if (LISTING_URL_RE.test(path)) return 'listing';
  if (BLOG_URL_RE.test(path)) return 'blog';
  return undefined;
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

function schemaTypeName(node: Record<string, unknown>): string {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : type != null ? [type] : [];
  const raw = types[0];
  if (raw == null) return '';
  const s = String(raw).toLowerCase();
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

export function inferTypeFromSchema(html: string): PageCardType | undefined {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).html()?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const node of collectJsonLdNodes(parsed)) {
        const name = schemaTypeName(node);
        if (SCHEMA_TYPE_MAP[name]) return SCHEMA_TYPE_MAP[name];
        if (name === 'product' || node.offers != null) return 'detail';
      }
    } catch {
      /* ignore */
    }
  }
  const ogType = $('meta[property="og:type"]').attr('content')?.toLowerCase();
  if (ogType === 'product') return 'detail';
  return undefined;
}

function normalizePageType(raw?: string): PageCardType | string {
  if (!raw) return 'page';
  const lower = raw.toLowerCase();
  const known: PageCardType[] = [
    'detail', 'listing', 'amenity', 'promotion', 'contact', 'content', 'blog', 'system', 'page',
  ];
  if (known.includes(lower as PageCardType)) return lower as PageCardType;
  if (lower === 'room' || lower === 'product') return 'detail';
  if (lower === 'offer' || lower === 'sale') return 'promotion';
  return raw;
}

function resolveDisplayTitle(input: PageCardMetadataInput): string | undefined {
  const heading = input.headingTitle?.trim();
  if (heading) return normalizeDisplayTitle(heading);
  return normalizeDisplayTitle(input.title);
}

export function resolvePageCardMetadata(input: PageCardMetadataInput): PageCardMetadataResult {
  const title = input.title?.trim();
  const url = input.url;
  const displayTitle = resolveDisplayTitle(input);

  if (hardExcludePage(url, title)) {
    return {
      type: 'system',
      cardEligible: false,
      cardPriority: 0,
      displayTitle,
      displayDescription: input.description,
      displayImageUrl: input.imageUrl,
    };
  }

  let type: PageCardType | string = normalizePageType(input.type);

  if (type === 'page' && input.html) {
    const fromSchema = inferTypeFromSchema(input.html);
    if (fromSchema) type = fromSchema;
  }
  if (type === 'page') {
    const fromUrl = inferTypeFromUrl(url);
    if (fromUrl) type = fromUrl;
  }
  if (input.hasProductPrice && type === 'page') {
    type = 'detail';
  }

  const typeKey = String(type).toLowerCase();
  let cardEligible = CARD_ELIGIBLE_DEFAULT[typeKey] ?? false;
  let cardPriority = CARD_PRIORITY[typeKey] ?? 3;

  if (cardEligible && PROMOTION_URL_RE.test(url.toLowerCase())) {
    cardEligible = false;
  }

  return {
    type,
    cardEligible,
    cardPriority,
    displayTitle,
    displayDescription: input.description?.trim() || undefined,
    displayImageUrl: input.imageUrl,
  };
}
