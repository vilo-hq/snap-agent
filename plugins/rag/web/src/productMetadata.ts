import * as cheerio from 'cheerio';
import { readPageEntity } from './pageEntity';

export interface ProductMetadata {
  price?: number;
  currency?: string;
  availability?: string;
}

/**
 * Extract structured product fields from HTML (JSON-LD, Open Graph, microdata).
 * Per-field priority: JSON-LD → Open Graph → microdata.
 *
 * Only the page's OWN product counts (see `readPageEntity`). A listing returns nothing: every price
 * on it belongs to a listed item, and taking the first one made a category page look like a product.
 * When the page does not say which product is its own, the first one is still used, as before.
 */
export function extractProductMetadata(html: string, pageUrl?: string): ProductMetadata {
  const $ = cheerio.load(html);
  const page = readPageEntity($, pageUrl);
  if (page.pageType === 'collection') return {};

  const fromJsonLd = page.ownProduct ? fieldsFromProductNode(page.ownProduct) : extractFromJsonLd($);
  const fromOg = extractFromOpenGraph($);
  const fromMicrodata = extractFromMicrodata($);

  const result: ProductMetadata = {};

  const price =
    fromJsonLd.price ?? fromOg.price ?? fromMicrodata.price;
  if (price != null) result.price = price;

  const currency =
    fromJsonLd.currency ?? fromOg.currency ?? fromMicrodata.currency;
  if (currency) result.currency = currency;

  const availability =
    fromJsonLd.availability ?? fromOg.availability ?? fromMicrodata.availability;
  if (availability) result.availability = availability;

  return result;
}

function extractFromJsonLd($: cheerio.CheerioAPI): ProductMetadata {
  const result: ProductMetadata = {};

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result.price != null && result.currency && result.availability) return false;

    const raw = $(el).html()?.trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const node of collectJsonLdNodes(parsed)) {
      if (!isProductType(node)) continue;

      const offer = pickOffer(node);
      if (!offer) continue;

      if (result.price == null) {
        const price = parsePrice(offer.price ?? offer.lowPrice ?? offer.highPrice);
        if (price != null) result.price = price;
      }
      if (!result.currency) {
        const currency = normalizeCurrency(offer.priceCurrency);
        if (currency) result.currency = currency;
      }
      if (!result.availability) {
        const availability = normalizeAvailability(offer.availability);
        if (availability) result.availability = availability;
      }
    }
  });

  return result;
}

function fieldsFromProductNode(node: Record<string, unknown>): ProductMetadata {
  // A `ProductGroup` often carries no offer of its own: each variant does.
  const variants = Array.isArray(node.hasVariant) ? node.hasVariant : node.hasVariant ? [node.hasVariant] : [];
  const offer = pickOffer(node) ?? variants
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .map(pickOffer)
    .find(Boolean) ?? null;
  if (!offer) return {};
  const result: ProductMetadata = {};
  const price = parsePrice(offer.price ?? offer.lowPrice ?? offer.highPrice);
  if (price != null) result.price = price;
  const currency = normalizeCurrency(offer.priceCurrency);
  if (currency) result.currency = currency;
  const availability = normalizeAvailability(offer.availability);
  if (availability) result.availability = availability;
  return result;
}

function extractFromOpenGraph($: cheerio.CheerioAPI): ProductMetadata {
  const result: ProductMetadata = {};

  const priceRaw =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content');
  const price = parsePrice(priceRaw);
  if (price != null) result.price = price;

  const currency = normalizeCurrency(
    $('meta[property="product:price:currency"]').attr('content') ||
      $('meta[property="og:price:currency"]').attr('content'),
  );
  if (currency) result.currency = currency;

  const availability = normalizeAvailability(
    $('meta[property="product:availability"]').attr('content') ||
      $('meta[property="og:availability"]').attr('content'),
  );
  if (availability) result.availability = availability;

  return result;
}

function microdataField($: cheerio.CheerioAPI, itemprop: string) {
  const scope = $('[itemtype*="schema.org/Product"], [itemtype*="schema.org/product"]').first();
  return scope.length > 0
    ? scope.find(`[itemprop="${itemprop}"]`).first()
    : $(`[itemprop="${itemprop}"]`).first();
}

function extractFromMicrodata($: cheerio.CheerioAPI): ProductMetadata {
  const result: ProductMetadata = {};

  const priceEl = microdataField($, 'price');
  const price = parsePrice(priceEl.attr('content') || priceEl.text());
  if (price != null) result.price = price;

  const currencyEl = microdataField($, 'priceCurrency');
  const currency = normalizeCurrency(currencyEl.attr('content') || currencyEl.text());
  if (currency) result.currency = currency;

  const availabilityEl = microdataField($, 'availability');
  const availability = normalizeAvailability(
    availabilityEl.attr('content') ||
      availabilityEl.attr('href') ||
      availabilityEl.text(),
  );
  if (availability) result.availability = availability;

  return result;
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

function isProductType(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : type != null ? [type] : [];
  return types.some(t => {
    const s = String(t).toLowerCase();
    return s === 'product' || s.endsWith('/product');
  });
}

function pickOffer(product: Record<string, unknown>): Record<string, unknown> | null {
  const offers = product.offers;
  if (offers == null) return null;

  if (Array.isArray(offers)) {
    const first = offers.find(o => o && typeof o === 'object') as Record<string, unknown> | undefined;
    return first ?? null;
  }
  if (typeof offers === 'object') return offers as Record<string, unknown>;
  return null;
}

export function parsePrice(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  let s = String(value).trim();
  if (!s) return undefined;

  s = s.replace(/[^\d.,\-]/g, '');
  if (!s || s === '-' || s === '.') return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      s = parts[0].replace(/\./g, '') + '.' + parts[1];
    } else {
      s = s.replace(/,/g, '');
    }
  }

  const num = parseFloat(s);
  return Number.isFinite(num) ? num : undefined;
}

export function normalizeCurrency(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim().toUpperCase();
  if (!s) return undefined;
  const iso = s.match(/[A-Z]{3}/);
  return iso ? iso[0] : s.length <= 4 ? s : undefined;
}

export function normalizeAvailability(value: unknown): string | undefined {
  if (value == null) return undefined;
  let s = String(value).trim();
  if (!s) return undefined;

  if (s.includes('schema.org/')) {
    const parts = s.split('/');
    s = parts[parts.length - 1] || s;
  }

  s = s.replace(/^https?:\/\/[^/]+\//, '');
  if (s.includes('/')) {
    const parts = s.split('/');
    s = parts[parts.length - 1] || s;
  }

  return s.replace(/\s+/g, '') || undefined;
}
