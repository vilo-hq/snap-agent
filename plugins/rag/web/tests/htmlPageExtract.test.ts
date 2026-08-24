import { describe, it, expect } from 'vitest';
import { extractPageFromHtml, sourceScopedDocumentId } from '../src/htmlPageExtract';

const BODY = '<p>' + 'x'.repeat(60) + '</p>';

describe('sourceScopedDocumentId', () => {
  it('es determinista', () => {
    const a = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    const b = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    expect(a).toBe(b);
  });

  it('distinguishes two long URLs that urlToDocumentId would collapse', () => {
    const base = 'https://x.test/' + 'a'.repeat(120);
    const uno = sourceScopedDocumentId('src-1', base + '/uno');
    const dos = sourceScopedDocumentId('src-1', base + '/dos');
    expect(uno).not.toBe(dos);
  });

  it('distingue la misma URL en sources distintos', () => {
    const uno = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    const dos = sourceScopedDocumentId('src-2', 'https://x.test/p/1');
    expect(uno).not.toBe(dos);
  });

  it('lleva el sourceId por delante para que sea legible en la base', () => {
    expect(sourceScopedDocumentId('src-1', 'https://x.test/p/1').startsWith('src-1:')).toBe(true);
  });
});

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

  it('keeps the content container and ignores out-of-container boilerplate even when body is longer', () => {
    const main = `<main><h1>Product</h1><p>${'Real product description long enough to index. '.repeat(2)}</p></main>`;
    const junk = `<div class="extra">${'BOILERPLATE '.repeat(50)}</div>`;
    const html = `<!DOCTYPE html><html><body>${main}${junk}</body></html>`;

    const result = extractPageFromHtml('https://shop.example.com/p', html);
    expect(result.content).toContain('Real product description');
    expect(result.content).not.toContain('BOILERPLATE');
  });

  it('prunes link-dense boilerplate blocks inside the content container', () => {
    const html = `<!DOCTYPE html><html><body><main>
      <p>This is the genuine article body text and it is definitely long enough to be indexed.</p>
      <div class="block">
        <a href="/a">Related product alpha</a>
        <a href="/b">Related product beta</a>
        <a href="/c">Related product gamma</a>
      </div>
    </main></body></html>`;

    const result = extractPageFromHtml('https://shop.example.com/p', html);
    expect(result.content).toContain('genuine article body text');
    expect(result.content).not.toContain('Related product');
  });

  it('falls back to <body> when no content container matches', () => {
    const html = `<!DOCTYPE html><html><body><h1>Title</h1><p>${'Plain body prose long enough to index. '.repeat(2)}</p></body></html>`;
    const result = extractPageFromHtml('https://example.com/p', html);
    expect(result.indexable).toBe(true);
    expect(result.content).toContain('Plain body prose');
  });

  // Real-estate extraction moved OUT of the SDK to the host app (a registered vertical pack). The
  // SDK core must therefore never tag a page with real-estate fields on its own.
  it('does NOT tag pages with real-estate fields (vertical packs are host-registered)', () => {
    // Property-ish prose ("casa", "oficina") but no listing structure → must stay clean.
    const body = `<main>
      <h1>SmithGroup Phoenix Office</h1>
      <p>${'Our office design connects people and purpose, drawing on the Sonoran Desert. '.repeat(3)}</p>
      <p>A welcoming casa-like atmosphere across the oficina floors near Camelback Mountain.</p>
    </main>`;
    const html = `<!DOCTYPE html><html><head><title>SmithGroup Phoenix Office</title></head><body>${body}</body></html>`;
    const result = extractPageFromHtml('https://smithgroup.com/projects/phoenix-office', html);

    expect(result.metadata.operationType).toBeUndefined();
    expect(result.metadata.propertyType).toBeUndefined();
    expect(result.metadata.expenses).toBeUndefined();
    expect(result.content).not.toMatch(/En venta|for sale|ambientes|Expensas/);
  });
});
