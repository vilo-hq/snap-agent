import type * as cheerio from 'cheerio';
import { LIST_TYPES, isProduct, nodeUrls, readPageEntity, schemaTypesOf, topLevelNodes } from './pageEntity';
import { parsePrice } from './productMetadata';

/** A product a listing page declares: what a visitor sees in its grid. */
export interface ListedProduct {
  name: string;
  price?: number;
  currency?: string;
  /** False when the offer says it is out of stock; absent when the page does not say. */
  available?: boolean;
  url?: string;
}

/** Most products read from one listing: a page of results, not a whole catalog. */
export const MAX_LISTED_PRODUCTS = 60;

const OUT_OF_STOCK = /(outofstock|soldout|discontinued)$/i;

function listedProduct(node: Record<string, unknown>, base: string | undefined): ListedProduct | undefined {
  const name = typeof node.name === 'string' ? node.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return undefined;
  const offers = node.offers;
  const offer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
  const price = offer && typeof offer === 'object' ? parsePrice(offer.price ?? offer.lowPrice) : undefined;
  const currency = offer && typeof offer.priceCurrency === 'string' ? offer.priceCurrency : undefined;
  const availability = offer && typeof offer.availability === 'string' ? offer.availability.trim() : '';
  const url = base ? nodeUrls(node, base)[0] : typeof node.url === 'string' ? node.url : undefined;
  return {
    name,
    ...(price != null ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(availability ? { available: !OUT_OF_STOCK.test(availability) } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * The products a LISTING page declares in its structured data — top-level `Product` nodes, or the
 * `Product` items of an `ItemList` — in page order, without repeats. Only products: a list of
 * articles or of properties is left alone. Empty for a page that is not a listing.
 *
 * WHY: once the interface is stripped, a listing's own text is just its heading, and its product
 * grid is pruned as a block of links. The products ARE what the listing says; the site states them
 * in its JSON-LD (Helena's «NUEVA COLECCIÓN - La Muse» declares the same 12 its grid shows).
 */
export function listedProducts($: cheerio.CheerioAPI, pageUrl?: string): ListedProduct[] {
  if (readPageEntity($, pageUrl).pageType !== 'collection') return [];
  const nodes: Record<string, unknown>[] = [];
  for (const { node } of topLevelNodes($)) {
    if (isProduct(node)) nodes.push(node);
    if (!schemaTypesOf(node).some((t) => LIST_TYPES.has(t)) || !Array.isArray(node.itemListElement)) continue;
    for (const element of node.itemListElement as unknown[]) {
      if (!element || typeof element !== 'object') continue;
      const el = element as Record<string, unknown>;
      const item = el.item && typeof el.item === 'object' ? (el.item as Record<string, unknown>) : el;
      if (isProduct(item)) nodes.push(item);
    }
  }
  const seen = new Set<string>();
  const out: ListedProduct[] = [];
  for (const node of nodes) {
    const product = listedProduct(node, pageUrl);
    if (!product) continue;
    const key = `${product.url ?? ''}|${product.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(product);
    if (out.length >= MAX_LISTED_PRODUCTS) break;
  }
  return out;
}
