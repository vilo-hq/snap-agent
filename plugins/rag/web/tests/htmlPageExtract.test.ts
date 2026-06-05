import { describe, it, expect } from 'vitest';
import { extractPageFromHtml } from '../src/htmlPageExtract';

const BODY = '<p>' + 'x'.repeat(60) + '</p>';

describe('extractPageFromHtml', () => {
  it('returns full metadata including product fields', () => {
    const html = `<!DOCTYPE html><html><head>
      <title>Shop | Widget</title>
      <meta property="og:description" content="A great widget." />
      <meta property="og:image" content="https://cdn.example.com/w.jpg" />
      <script type="application/ld+json">
      {"@type":"Product","name":"Widget","offers":{"price":"10.5","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
      </script>
    </head><body><main><h1>Widget</h1>${BODY}</main></body></html>`;

    const result = extractPageFromHtml('https://shop.example.com/product/widget', html, {
      defaultType: 'product',
    });

    expect(result.indexable).toBe(true);
    expect(result.metadata).toMatchObject({
      type: 'detail',
      cardEligible: true,
      title: 'Shop | Widget',
      displayTitle: 'Widget',
      url: 'https://shop.example.com/product/widget',
      description: 'A great widget.',
      imageUrl: 'https://cdn.example.com/w.jpg',
      price: 10.5,
      currency: 'USD',
      availability: 'InStock',
    });
    expect(result.content.length).toBeGreaterThan(50);
    expect(result.contentPreview.length).toBeGreaterThan(0);
  });

  it('returns metadata even when content is too short to index', () => {
    const html = `<!DOCTYPE html><html><head>
      <meta property="product:price:amount" content="99" />
      <meta property="product:price:currency" content="EUR" />
    </head><body><h1>Short</h1><p>Hi</p></body></html>`;

    const result = extractPageFromHtml('https://example.com/p', html);
    expect(result.indexable).toBe(false);
    expect(result.metadata.price).toBe(99);
    expect(result.metadata.currency).toBe('EUR');
  });
});
