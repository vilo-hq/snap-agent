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

  it('merges real estate metadata when product tags are absent', () => {
    const body = `<main>
      <h1>Departamento en venta en Puerto Madero</h1>
      <div class="price">$ 1,400,000</div>
      <ul>
        <li>2 Dormitorios</li>
        <li>Baños: 1</li>
        <li>176 m2 Cubiertos</li>
      </ul>
      <p>${'x'.repeat(60)}</p>
    </main>`;
    const html = `<!DOCTYPE html><html><head>
      <title>Amarras Center Torre | Salas Inmobiliaria</title>
    </head><body>${body}</body></html>`;

    const result = extractPageFromHtml(
      'https://www.salasinmobiliaria.com.ar/propiedad/4745-amarras-center-torre.html',
      html,
    );

    expect(result.metadata).toMatchObject({
      type: 'detail',
      cardEligible: true,
      price: 1400000,
      currency: 'ARS',
      operationType: 'sale',
      propertyType: 'Departamento',
      bedrooms: 2,
      bathrooms: 1,
      coveredSqMeters: 176,
    });
    expect(result.content).toContain('En venta / for sale.');
    expect(result.content).toContain('2 dormitorios / bedrooms.');
  });

  it('classifies REMAX listing URLs as detail cards with rent metadata', () => {
    const body = `<main>
      <h1>DEPTO EN ALQUILER 2 AMB LUMINOSO EXCELENTE</h1>
      <div>760.000 ARS</div>
      <div>Expensas : 156.000 ARS</div>
      <div>2ambientes</div>
      <div>1dormitorio</div>
      <div>36.8 m² cubiertos</div>
      <p>${'x'.repeat(60)}</p>
    </main>`;
    const html = `<!DOCTYPE html><html><head>
      <title>Departamento en alquiler 2 ambientes en Guido 1700</title>
    </head><body>${body}</body></html>`;

    const result = extractPageFromHtml(
      'https://www.remax.com.ar/listings/depto-en-alquiler-2-amb-luminoso-excelente',
      html,
    );

    expect(result.metadata).toMatchObject({
      type: 'detail',
      cardEligible: true,
      price: 760000,
      currency: 'ARS',
      operationType: 'rent',
      expenses: 156000,
    });
  });
});
