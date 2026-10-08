import * as cheerio from 'cheerio';

/**
 * What a page IS, read from its own schema.org: a detail page (one entity) or a listing (many).
 *
 * WHY: product data used to come from the FIRST `Product` node on the page. A listing carries one
 * `Product` per listed item, so a category page took the price of the first product it listed and
 * looked like a product itself. MEASURED on a Tiendanube store (2026-10-08): 16 category and landing
 * pages — the home page included — carried a price this way and showed up as product cards.
 *
 * Counting `Product` nodes alone does not tell the two apart either: the same store's product page
 * carries eight more in its "you may also like" carousel. What does is the page-level declaration,
 * in the order the standards give it:
 *
 *  1. A `WebPage` node: `CollectionPage`/`SearchResultsPage` is a listing; `ItemPage`/`ProfilePage`/
 *     `QAPage` a detail page; a `WebPage` whose `mainEntity` is a typed entity is the page OF that
 *     entity, unless the entity is a list (`ItemList`, `OfferCatalog`).
 *  2. `og:type` naming an object (`product`, `profile`, `book`, `place`) — never `website` or
 *     `article`, which many CMSs set on any page.
 *  3. Only then the count: several `Product` nodes (or an `ItemList`) and none that is the page's
 *     own means a listing.
 */
export type DeclaredPageType = 'detail' | 'collection';

export interface PageEntityReading {
  /** The page's own product node, when the page says which one it is. */
  ownProduct?: Record<string, unknown>;
  /** Every top-level `Product` node on the page, in document order. */
  products: Record<string, unknown>[];
  pageType?: DeclaredPageType;
}

const LISTING_PAGE_TYPES = new Set(['collectionpage', 'searchresultspage']);
const DETAIL_PAGE_TYPES = new Set(['itempage', 'profilepage', 'qapage']);
const WEB_PAGE_TYPES = new Set([
  'webpage', 'aboutpage', 'contactpage', 'faqpage', 'checkoutpage', 'medicalwebpage', 'realestatelisting',
  ...LISTING_PAGE_TYPES, ...DETAIL_PAGE_TYPES,
]);
const LIST_TYPES = new Set(['itemlist', 'offercatalog']);
const OG_DETAIL_TYPE = /(^|[:.])(product|profile|book|place)(\.|$)/;

export function schemaTypesOf(node: Record<string, unknown>): string[] {
  const type = node['@type'];
  return (Array.isArray(type) ? type : type != null ? [type] : []).map((raw) => {
    const s = String(raw).toLowerCase();
    const slash = s.lastIndexOf('/');
    return slash >= 0 ? s.slice(slash + 1) : s;
  }).filter(Boolean);
}

/** `ProductGroup` is a `Product` in schema.org: the page of a product sold in several variants. */
const isProduct = (node: Record<string, unknown>) => schemaTypesOf(node).some((t) => t === 'product' || t === 'productgroup');

interface PlacedNode { node: Record<string, unknown>; inHead: boolean }

/** Top-level and `@graph` nodes of every JSON-LD block, with where the block sits. */
function topLevelNodes($: cheerio.CheerioAPI): PlacedNode[] {
  const out: PlacedNode[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).html()?.trim();
    if (!raw) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    const inHead = $(element).closest('head').length > 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      out.push({ node, inHead });
      if (node['@graph']) visit(node['@graph']);
    };
    visit(parsed);
  });
  return out;
}

function pageKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return undefined;
  }
}

/** URLs a node points at to say which page it belongs to: its own, its page's, its offer's. */
function nodeUrls(node: Record<string, unknown>, base: string): string[] {
  const refs: unknown[] = [node.url, node['@id']];
  const page = node.mainEntityOfPage;
  refs.push(...(Array.isArray(page) ? page : [page]).map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>)['@id'] ?? (p as Record<string, unknown>).url : p)));
  const offers = node.offers;
  refs.push(...(Array.isArray(offers) ? offers : [offers]).map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>).url : undefined)));
  return refs.flatMap((ref) => {
    if (typeof ref !== 'string' || !ref.trim() || ref.trim().startsWith('_:')) return [];
    try { return [new URL(ref.trim(), base).toString()]; } catch { return []; }
  });
}

export function readPageEntity($: cheerio.CheerioAPI, pageUrl?: string): PageEntityReading {
  const nodes = topLevelNodes($);
  const products = nodes.filter((p) => isProduct(p.node));
  let pageType: DeclaredPageType | undefined;
  let ownProduct: Record<string, unknown> | undefined;

  // 1. The page-level declaration.
  for (const { node } of nodes) {
    const types = schemaTypesOf(node);
    if (!types.some((t) => WEB_PAGE_TYPES.has(t))) continue;
    if (types.some((t) => LISTING_PAGE_TYPES.has(t))) { pageType = 'collection'; break; }
    if (types.some((t) => DETAIL_PAGE_TYPES.has(t))) pageType = 'detail';
    const main = node.mainEntity;
    const entity = (Array.isArray(main) ? main : [main]).find((m) => m && typeof m === 'object' && schemaTypesOf(m as Record<string, unknown>).length);
    if (entity) {
      const entityTypes = schemaTypesOf(entity as Record<string, unknown>);
      pageType = entityTypes.some((t) => LIST_TYPES.has(t)) ? 'collection' : 'detail';
      if (isProduct(entity as Record<string, unknown>)) ownProduct = entity as Record<string, unknown>;
      break;
    }
    if (pageType) break;
  }

  // The page's own product, when the declaration did not name it: the one that points at this page,
  // else the only one that does not point at another page, else the only one in <head>.
  if (!ownProduct && products.length && pageType !== 'collection') {
    const here = pageUrl ? pageKey(pageUrl) : undefined;
    const pointsHere = (p: PlacedNode) => here !== undefined && nodeUrls(p.node, pageUrl!).some((u) => pageKey(u) === here);
    const pointsElsewhere = (p: PlacedNode) => here !== undefined && nodeUrls(p.node, pageUrl!).some((u) => pageKey(u) !== here);
    const matching = products.filter(pointsHere);
    if (matching.length) {
      ownProduct = matching[0]!.node;
      pageType = pageType ?? 'detail';
    } else {
      const local = products.filter((p) => !pointsElsewhere(p));
      const inHead = local.filter((p) => p.inHead);
      ownProduct = local.length === 1 ? local[0]!.node : inHead.length === 1 ? inHead[0]!.node : undefined;
    }
  }

  // 2. og:type naming an object.
  if (!pageType) {
    const og = ($('meta[property="og:type"]').attr('content') ?? '').trim().toLowerCase();
    if (og && OG_DETAIL_TYPE.test(og)) pageType = 'detail';
  }

  // 3. The count: many items and none of them this page's own.
  if (!pageType && !ownProduct) {
    const listsMany = nodes.some(({ node }) => schemaTypesOf(node).some((t) => LIST_TYPES.has(t))
      && Array.isArray(node.itemListElement) && node.itemListElement.length >= 2);
    if (products.length >= 2 || listsMany) pageType = 'collection';
  }

  return { ownProduct, products: products.map((p) => p.node), pageType };
}
