import { describe, it, expect } from 'vitest';
import {
  extractProductMetadata,
  parsePrice,
  normalizeCurrency,
  normalizeAvailability,
} from '../src/productMetadata';

const MIN_CONTENT = 'x'.repeat(60);

function wrapBody(inner: string): string {
  return `<!DOCTYPE html><html><head>${inner}</head><body><main><h1>Test Product</h1><p>${MIN_CONTENT}</p></main></body></html>`;
}

describe('productMetadata', () => {
  describe('parsePrice', () => {
    it('parses plain numbers and US format', () => {
      expect(parsePrice(29.99)).toBe(29.99);
      expect(parsePrice('$1,299.00')).toBe(1299);
      expect(parsePrice('1,299.00')).toBe(1299);
    });

    it('parses European format', () => {
      expect(parsePrice('1.299,00')).toBe(1299);
    });
  });

  describe('normalizeCurrency', () => {
    it('uppercases ISO codes', () => {
      expect(normalizeCurrency('usd')).toBe('USD');
      expect(normalizeCurrency(' ARS ')).toBe('ARS');
    });
  });

  describe('normalizeAvailability', () => {
    it('extracts suffix from schema.org URLs', () => {
      expect(normalizeAvailability('https://schema.org/InStock')).toBe('InStock');
      expect(normalizeAvailability('http://schema.org/OutOfStock')).toBe('OutOfStock');
    });
  });

  describe('extractProductMetadata', () => {
    it('extracts from JSON-LD Product + Offer', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Widget",
          "offers": {
            "@type": "Offer",
            "price": "49.99",
            "priceCurrency": "USD",
            "availability": "https://schema.org/InStock"
          }
        }
        </script>
      `);

      expect(extractProductMetadata(html)).toEqual({
        price: 49.99,
        currency: 'USD',
        availability: 'InStock',
      });
    });

    it('extracts from JSON-LD @graph', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", "name": "Shop" },
            {
              "@type": "Product",
              "offers": {
                "price": 120,
                "priceCurrency": "EUR",
                "availability": "PreOrder"
              }
            }
          ]
        }
        </script>
      `);

      expect(extractProductMetadata(html)).toEqual({
        price: 120,
        currency: 'EUR',
        availability: 'PreOrder',
      });
    });

    it('extracts from Open Graph product tags', () => {
      const html = wrapBody(`
        <meta property="product:price:amount" content="199.50" />
        <meta property="product:price:currency" content="ars" />
        <meta property="product:availability" content="instock" />
      `);

      expect(extractProductMetadata(html)).toEqual({
        price: 199.5,
        currency: 'ARS',
        availability: 'instock',
      });
    });

    it('extracts from microdata', () => {
      const html = wrapBody(`
        <div itemscope itemtype="https://schema.org/Product">
          <span itemprop="price" content="75.00">75</span>
          <meta itemprop="priceCurrency" content="USD" />
          <link itemprop="availability" href="https://schema.org/OutOfStock" />
        </div>
      `);

      expect(extractProductMetadata(html)).toEqual({
        price: 75,
        currency: 'USD',
        availability: 'OutOfStock',
      });
    });

    it('returns empty object when no product signals', () => {
      const html = wrapBody(`<meta name="description" content="A blog post" />`);
      expect(extractProductMetadata(html)).toEqual({});
    });

    it('prefers JSON-LD over Open Graph when both present', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@type": "Product",
          "offers": { "price": "10.00", "priceCurrency": "USD", "availability": "InStock" }
        }
        </script>
        <meta property="product:price:amount" content="999.00" />
        <meta property="product:price:currency" content="EUR" />
        <meta property="product:availability" content="OutOfStock" />
      `);

      expect(extractProductMetadata(html)).toEqual({
        price: 10,
        currency: 'USD',
        availability: 'InStock',
      });
    });

    it('uses lowPrice when price is absent in Offer', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@type": "Product",
          "offers": { "lowPrice": "29.00", "priceCurrency": "USD" }
        }
        </script>
      `);

      expect(extractProductMetadata(html)).toMatchObject({
        price: 29,
        currency: 'USD',
      });
    });
  });
});

/**
 * The page's OWN product, not the first one on the page. Shapes from a Tiendanube store
 * (2026-10-08): a product page names its product as `WebPage.mainEntity` and carries more products
 * in a carousel; a category page carries one product per listed item and declares none as its own.
 */
describe('page entity: own product vs listing', () => {
  const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
  const product = (name: string, url: string, price: string, extra: Record<string, unknown> = {}) => ({
    '@context': 'https://schema.org/', '@type': 'Product', name, ...extra,
    offers: { '@type': 'Offer', url, price, priceCurrency: 'ARS', availability: 'https://schema.org/InStock' },
  });
  const carousel = [1, 2, 3].map((i) => ld(product(`Otro ${i}`, `https://shop.test/productos/otro-${i}/`, `${i}0000`, {
    mainEntityOfPage: { '@type': 'WebPage', '@id': `https://shop.test/productos/otro-${i}/` },
  }))).join('');

  it('takes the price of the product the page declares as its main entity', () => {
    const html = `<html><head>${ld({ '@type': 'WebPage', mainEntity: product('Remera', 'https://shop.test/productos/remera/', '38900') })}</head><body>${carousel}</body></html>`;
    expect(extractProductMetadata(html, 'https://shop.test/productos/remera/').price).toBe(38900);
  });

  it('finds its own product by URL even when a carousel product comes first', () => {
    const html = `<html><head></head><body>${carousel}${ld(product('Remera', 'https://shop.test/productos/remera/', '38900'))}</body></html>`;
    expect(extractProductMetadata(html, 'https://shop.test/productos/remera/').price).toBe(38900);
  });

  it('gives a listing no price of its own', () => {
    const html = `<html><head>${ld({ '@type': 'WebPage', breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [] } })}</head><body>${carousel}</body></html>`;
    expect(extractProductMetadata(html, 'https://shop.test/clasicos/camisas/')).toEqual({});
  });

  it('keeps the first product when a product page does not say which one is its own', () => {
    const html = `<html><head><meta property="og:type" content="product"></head><body>${ld(product('A', '', '100'))}${ld(product('B', '', '200'))}</body></html>`;
    expect(extractProductMetadata(html, 'https://shop.test/p/a/').price).toBe(100);
  });

  it('reads a ProductGroup as the page product, with the offer of its first variant', () => {
    const group = {
      '@type': 'ProductGroup', name: 'Vestido midi', url: 'https://shop.test/vestidos/vestido-midi/17074',
      hasVariant: [product('Vestido midi Negro S', 'https://shop.test/vestidos/vestido-midi/17074?pa=1', '14.99', { color: 'Negro' })],
    };
    const html = `<html><head>${ld(group)}</head><body>${carousel}</body></html>`;
    expect(extractProductMetadata(html, 'https://shop.test/vestidos/vestido-midi/17074')).toMatchObject({ price: 14.99, currency: 'ARS' });
  });
});
