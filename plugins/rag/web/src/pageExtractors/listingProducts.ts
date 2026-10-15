import { listedProducts, type ListedProduct } from '../listedProducts';
import { readPageEntity } from '../pageEntity';
import type { PageAttributeExtractor, PageExtractionResult } from './types';

/**
 * Built-in listing extractor: a listing page's content is the products it shows. Reads them from the
 * page's own structured data (`listedProducts`) and appends them as one block of text, so a search
 * for a collection finds the listing by what is in it — not by its heading alone.
 *
 * `detect()` is structural: only pages `readPageEntity` already calls a listing. Adds no price and
 * no price signal: a listing is not a product (see `extractProductMetadata`).
 */
export const listingProductsExtractor: PageAttributeExtractor = {
  id: 'listing-products',

  detect({ $, url }) {
    return readPageEntity($, url).pageType === 'collection' ? 1 : 0;
  },

  extract({ $, url }): PageExtractionResult {
    const block = formatListedProducts(listedProducts($, url));
    return { metadata: {}, contentLines: block ? [block] : [] };
  },
};

const amount = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** One line per product — name, price, and stock when the page says it is out — under a bilingual label. */
export function formatListedProducts(products: ListedProduct[]): string {
  if (products.length === 0) return '';
  const lines = products.map((p) => {
    const price = p.price != null ? ` — ${amount(p.price)}${p.currency ? ` ${p.currency}` : ''}` : '';
    const stock = p.available === false ? ' (sin stock / out of stock)' : '';
    return `- ${p.name}${price}${stock}`;
  });
  return [`Productos en esta página / products on this page (${products.length}):`, ...lines].join('\n');
}
