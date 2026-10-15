import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { listedProducts, MAX_LISTED_PRODUCTS } from '../src/listedProducts';
import { formatListedProducts } from '../src/pageExtractors/listingProducts';
import { extractPageFromHtml } from '../src/htmlPageExtract';

const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
const product = (i: number, extra: Record<string, unknown> = {}) => ({
  '@type': 'Product',
  name: `Top ${i}`,
  offers: { '@type': 'Offer', url: `https://shop.test/p/${i}/`, price: `${i}000`, priceCurrency: 'ARS', availability: 'https://schema.org/InStock' },
  ...extra,
});
const page = (body: string) => cheerio.load(`<html><head><title>Colección</title></head><body>${body}</body></html>`);

describe('listedProducts', () => {
  it('reads the top-level products of a listing, in page order', () => {
    const $ = page([1, 2, 3].map((i) => ld(product(i))).join(''));
    expect(listedProducts($, 'https://shop.test/coleccion/')).toEqual([
      { name: 'Top 1', price: 1000, currency: 'ARS', available: true, url: 'https://shop.test/p/1/' },
      { name: 'Top 2', price: 2000, currency: 'ARS', available: true, url: 'https://shop.test/p/2/' },
      { name: 'Top 3', price: 3000, currency: 'ARS', available: true, url: 'https://shop.test/p/3/' },
    ]);
  });

  it('reads the products of an ItemList, and says when one is out of stock', () => {
    const list = {
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: product(1) },
        { '@type': 'ListItem', position: 2, item: product(2, { offers: { price: '2000', priceCurrency: 'ARS', availability: 'https://schema.org/OutOfStock' } }) },
      ],
    };
    const items = listedProducts(page(ld(list)), 'https://shop.test/coleccion/');
    expect(items.map((p) => [p.name, p.available])).toEqual([['Top 1', true], ['Top 2', false]]);
  });

  it('leaves a list of non-products alone', () => {
    const list = { '@type': 'ItemList', itemListElement: [1, 2, 3].map((i) => ({ '@type': 'ListItem', item: { '@type': 'Article', name: `Nota ${i}` } })) };
    expect(listedProducts(page(ld(list)), 'https://site.test/notas/')).toEqual([]);
  });

  it('is empty on a product page, even with related products declared', () => {
    const own = { '@type': 'WebPage', mainEntity: product(9, { offers: { '@type': 'Offer', url: 'https://shop.test/p/9/', price: '9000', priceCurrency: 'ARS' } }) };
    expect(listedProducts(page(ld(own) + ld(product(1)) + ld(product(2))), 'https://shop.test/p/9/')).toEqual([]);
  });

  it('drops repeats and stops at the cap', () => {
    const many = Array.from({ length: MAX_LISTED_PRODUCTS + 10 }, (_, i) => ld(product(i + 1))).join('');
    expect(listedProducts(page(many + ld(product(1))), 'https://shop.test/coleccion/')).toHaveLength(MAX_LISTED_PRODUCTS);
  });
});

describe('formatListedProducts', () => {
  it('one line per product under a bilingual label', () => {
    expect(formatListedProducts([
      { name: 'Jean Paz', price: 119000, currency: 'ARS', available: true },
      { name: 'Top Liz', price: 49.5, available: false },
      { name: 'Gift Card' },
    ])).toBe([
      'Productos en esta página / products on this page (3):',
      '- Jean Paz — 119000 ARS',
      '- Top Liz — 49.50 (sin stock / out of stock)',
      '- Gift Card',
    ].join('\n'));
  });

  it('is empty without products', () => {
    expect(formatListedProducts([])).toBe('');
  });
});

describe('a listing page as indexed', () => {
  it('is its heading plus the products it declares, and still carries no price', () => {
    const html = `<html><head><title>La Muse</title></head><body>${[1, 2].map((i) => ld(product(i))).join('')}<div class="js-modal modal">¡Agregado al carrito!</div><h1>NUEVA COLECCIÓN - La Muse</h1></body></html>`;
    const result = extractPageFromHtml('https://shop.test/nueva-coleccion-la-muse/', html);
    expect(result.content).toBe([
      'NUEVA COLECCIÓN - La Muse',
      '',
      'Productos en esta página / products on this page (2):',
      '- Top 1 — 1000 ARS',
      '- Top 2 — 2000 ARS',
    ].join('\n'));
    expect(result.metadata.price).toBeUndefined();
    expect(result.indexable).toBe(true);
  });
});
