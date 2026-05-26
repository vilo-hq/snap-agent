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
