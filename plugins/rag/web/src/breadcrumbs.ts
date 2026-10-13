import type * as cheerio from 'cheerio';

/** One step of the trail the page shows above itself: a category, a section. */
export interface BreadcrumbItem {
  name: string;
  /** Absolute URL of that step's page, when the trail links it. */
  url?: string;
}

const MAX_ITEMS = 8;
const MAX_NAME = 120;
/** A step that is only punctuation is a separator the theme rendered as text (`.`, `/`, `›`). */
const SEPARATOR_ONLY = /^[\s./\\|>»›·•:-]*$/;

const HTML_TRAIL_SELECTOR =
  '[itemtype*="BreadcrumbList" i], nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]';

function clean(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

function absolute(href: unknown, base: string): string | undefined {
  if (typeof href !== 'string' || !href.trim() || href.trim().startsWith('#') || href.trim().startsWith('javascript:')) return undefined;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return undefined;
  }
}

function pageKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return undefined;
  }
}

function isSiteRoot(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
}

/** Every `BreadcrumbList` in the JSON-LD, wherever it sits: top level, `@graph`, or a `WebPage.breadcrumb`. */
function jsonLdTrails($: cheerio.CheerioAPI, base: string): BreadcrumbItem[][] {
  const trails: BreadcrumbItem[][] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return; }
    const node = value as Record<string, unknown>;
    const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).map((t) => String(t ?? '').toLowerCase());
    if (types.some((t) => t.endsWith('breadcrumblist')) && Array.isArray(node.itemListElement)) {
      const items = (node.itemListElement as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e, index) => {
          const item = e.item;
          const itemNode = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
          const position = Number(e.position);
          return {
            position: Number.isFinite(position) ? position : index + 1,
            name: clean(e.name ?? itemNode?.name),
            url: absolute(typeof item === 'string' ? item : itemNode?.['@id'] ?? itemNode?.url, base),
          };
        })
        .sort((a, b) => a.position - b.position)
        .map(({ name, url }) => ({ name, ...(url ? { url } : {}) }));
      trails.push(items);
      return;
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).html()?.trim();
    if (!raw) return;
    try { visit(JSON.parse(raw), 0); } catch { /* one broken block does not invalidate the others */ }
  });
  return trails;
}

/** The trail as the theme renders it: its links in order, then the unlinked current step, if any. */
function htmlTrail($: cheerio.CheerioAPI, base: string): BreadcrumbItem[] {
  // The innermost match: a theme often nests `.breadcrumbs > .breadcrumb`, and the outer one would
  // read the same steps twice.
  const container = $(HTML_TRAIL_SELECTOR).filter((_, el) => $(el).find(HTML_TRAIL_SELECTOR).length === 0).first();
  if (!container.length) return [];
  const steps = container.find('li').length
    ? container.find('li').toArray().map((li) => {
      const link = $(li).find('a[href]').first();
      return { name: clean((link.length ? link : $(li)).text()), url: link.length ? absolute(link.attr('href'), base) : undefined };
    })
    : container.find('a[href], [class*="active" i], [aria-current]').toArray().map((el) => ({
      name: clean($(el).text()),
      url: el.tagName === 'a' ? absolute($(el).attr('href'), base) : undefined,
    }));
  return steps.map(({ name, url }) => ({ name, ...(url ? { url } : {}) }));
}

/**
 * The breadcrumb the page declares — the path from the site's home to this page, as the site
 * itself states it. For a product that is its category (`NUEVA COLECCIÓN › Tops, camisas y
 * remeras`), something no other part of the page says.
 *
 * Read from the full HTML: the content extractor strips the breadcrumb as page chrome, and as text
 * it is noise; as evidence it is the page's own classification. schema.org `BreadcrumbList` first
 * (the standard, and unambiguous about order and links), else the trail the theme renders.
 *
 * Returned without the home step (its URL is the site root) and without this page's own step (its
 * URL is this page, or it is the unlinked last step): what is left are the sections the page sits in.
 */
export function readBreadcrumbs($: cheerio.CheerioAPI, pageUrl: string): BreadcrumbItem[] {
  const fromJsonLd = jsonLdTrails($, pageUrl).find((trail) => trail.length > 0);
  const trail = fromJsonLd ?? htmlTrail($, pageUrl);
  const here = pageKey(pageUrl);
  const steps = trail.filter((step) => step.name && !SEPARATOR_ONLY.test(step.name) && !isSiteRoot(step.url));
  const last = steps[steps.length - 1];
  const isOwnStep = last !== undefined && (last.url ? pageKey(last.url) === here : true);
  return (isOwnStep ? steps.slice(0, -1) : steps).slice(0, MAX_ITEMS);
}
