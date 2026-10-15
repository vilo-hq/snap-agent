import { describe, it, expect } from 'vitest';
import { declaresOwnContent, extractPageFromHtml, sourceScopedDocumentId, trustedCanonicalUrl } from '../src/htmlPageExtract';
import { stripTrackingParams } from '../src/trackingParams';

const BODY = '<p>' + 'x'.repeat(60) + '</p>';

describe('sourceScopedDocumentId', () => {
  it('is deterministic', () => {
    const a = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    const b = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    expect(a).toBe(b);
  });

  it('distinguishes two long URLs that urlToDocumentId would collapse', () => {
    const base = 'https://x.test/' + 'a'.repeat(120);
    const first = sourceScopedDocumentId('src-1', base + '/one');
    const second = sourceScopedDocumentId('src-1', base + '/two');
    expect(first).not.toBe(second);
  });

  it('distinguishes the same URL under different sources', () => {
    const first = sourceScopedDocumentId('src-1', 'https://x.test/p/1');
    const second = sourceScopedDocumentId('src-2', 'https://x.test/p/1');
    expect(first).not.toBe(second);
  });

  it('puts the sourceId up front so a row stays readable in the database', () => {
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
      // El llamador dijo `product` y le queda `product`. Antes se reescribía a `detail`: el plugin
      // pisaba la palabra de quien sí conoce la vertical.
      type: 'product',
      title: 'Shop | Widget',
      displayTitle: 'Widget',
      url: 'https://shop.example.com/product/widget',
      description: 'A great widget.',
      imageUrl: 'https://cdn.example.com/w.jpg',
      price: 10.5,
      currency: 'USD',
      availability: 'InStock',
    });
    // La elegibilidad ya no se decide acá.
    expect(result.metadata.cardEligible).toBeUndefined();
    expect(result.metadata.cardPriority).toBeUndefined();
    // Y lo que la página declaró viaja como evidencia, sin aplanar.
    expect(result.metadata.observations).toMatchObject({
      schemaTypes: expect.arrayContaining(['product', 'offer']),
      pathSegments: ['product', 'widget'],
      signals: expect.objectContaining({ hasPrice: true, hasH1: true }),
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
      <h1>Example Studio Phoenix Office</h1>
      <p>${'Our office design connects people and purpose, drawing on the Sonoran Desert. '.repeat(3)}</p>
      <p>A welcoming casa-like atmosphere across the oficina floors near Camelback Mountain.</p>
    </main>`;
    const html = `<!DOCTYPE html><html><head><title>Example Studio Phoenix Office</title></head><body>${body}</body></html>`;
    const result = extractPageFromHtml('https://example.com/projects/phoenix-office', html);

    expect(result.metadata.operationType).toBeUndefined();
    expect(result.metadata.propertyType).toBeUndefined();
    expect(result.metadata.expenses).toBeUndefined();
    expect(result.content).not.toMatch(/En venta|for sale|ambientes|Expensas/);
  });
});

describe('page identity', () => {
  const carousel = 'https://shop.test/productos/pantalon/?recommendation_source=alternative-carousel&recommender=manual';
  const page = (head: string) => `<html><head><title>Pantalón</title>${head}</head><body>${BODY}</body></html>`;

  it('strips tracking params from the stored url and the id, keeping the ones that change content', () => {
    const extracted = extractPageFromHtml(carousel, page(''));
    expect(extracted.identityUrl).toBe('https://shop.test/productos/pantalon/');
    expect(extracted.metadata.url).toBe('https://shop.test/productos/pantalon/');
    expect(extracted.id).toBe(extractPageFromHtml('https://shop.test/productos/pantalon/', page('')).id);
    expect(stripTrackingParams('https://x.test/list?p=2&utm_source=a&variant=7')).toBe('https://x.test/list?p=2&variant=7');
  });

  it('reports a trusted canonical without applying it', () => {
    const extracted = extractPageFromHtml(carousel, page('<link rel="canonical" href="/productos/pantalon/" />'));
    expect(extracted.canonicalUrl).toBe('https://shop.test/productos/pantalon/');
    expect(extracted.identityUrl).toBe('https://shop.test/productos/pantalon/');
  });

  it('reads rel lists and survives the noise stripping', () => {
    const extracted = extractPageFromHtml('https://shop.test/p/1?variant=9', page('<link rel="alternate canonical" href="https://www.shop.test/p/1" />'));
    expect(extracted.canonicalUrl).toBe('https://www.shop.test/p/1');
  });

  it('only trusts a canonical on the same site that does not collapse an inner page onto the homepage', () => {
    expect(trustedCanonicalUrl('https://shop.test/p/1', 'https://www.shop.test/p/1')).toBe('https://www.shop.test/p/1');
    expect(trustedCanonicalUrl('https://shop.test/p/1', 'https://syndicator.test/p/1')).toBeNull();
    expect(trustedCanonicalUrl('https://shop.test/p/1', 'https://shop.test/')).toBeNull();
    expect(trustedCanonicalUrl('https://shop.test/', 'https://shop.test/')).toBe('https://shop.test/');
    expect(trustedCanonicalUrl('https://shop.test/p/1', 'javascript:alert(1)')).toBeNull();
    expect(trustedCanonicalUrl('https://shop.test/p/1', '   ')).toBeNull();
  });
});

describe('observations.pageType', () => {
  const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
  const listed = [1, 2].map((i) => ld({ '@type': 'Product', name: `P${i}`, offers: { '@type': 'Offer', url: `https://shop.test/p/${i}/`, price: '10' } })).join('');
  it('marks a listing and leaves its price out', () => {
    const extracted = extractPageFromHtml('https://shop.test/coleccion/', `<html><head><title>Colección</title></head><body>${BODY}${listed}</body></html>`);
    expect((extracted.metadata.observations as { pageType?: string }).pageType).toBe('collection');
    expect(extracted.metadata.price).toBeUndefined();
  });
  it('marks the page of a declared entity as a detail page', () => {
    const extracted = extractPageFromHtml('https://shop.test/p/1/', `<html><head><title>P1</title>${ld({ '@type': 'WebPage', mainEntity: { '@type': 'Product', name: 'P1', offers: { '@type': 'Offer', price: '10', priceCurrency: 'ARS' } } })}</head><body>${BODY}${listed}</body></html>`);
    expect((extracted.metadata.observations as { pageType?: string }).pageType).toBe('detail');
    expect(extracted.metadata.price).toBe(10);
  });
  it('says nothing about a page that declares nothing', () => {
    const extracted = extractPageFromHtml('https://shop.test/about/', `<html><head><title>About</title></head><body>${BODY}</body></html>`);
    expect((extracted.metadata.observations as { pageType?: string }).pageType).toBeUndefined();
  });
});

// A storefront theme with no content container (Tiendanube, as on Helena, 2026-10-15): the body
// fallback used to keep the pop-ups, the sort dropdown and the filter panel as the page's text.
describe('interface chrome', () => {
  const chrome = `
    <div class="js-modal modal modal-bottom" id="related-products-notification"><div class="modal-header">¡Agregado al carrito!</div><a href="/cart">Ver carrito</a></div>
    <div class="js-modal modal" id="js-cross-selling-modal"><div class="modal-header">¡Descuento exclusivo!</div></div>
    <dialog open>Medios de pago: 15% OFF con transferencia</dialog>
    <div role="dialog">Suscribite y obtené un cupón</div>
    <div aria-modal="true">Elegí tu talle</div>
    <select class="js-sort-by"><option>Precio: menor a mayor</option><option>Más vendidos</option></select>
    <div class="filters-sidebar"><h5>Filtrar por</h5>Color Negro (2) Blanco (5) Talle S (82)</div>`;
  const product = '<h1>Pantalón Madrid Verde Militar</h1><p>Pantalón corte palazzo, amplio de piernas, con pinzas, cierre y botón. Composición: tencel.</p>';

  it('drops pop-ups, a sort dropdown and a filter panel when the body is the content', () => {
    const result = extractPageFromHtml('https://shop.test/productos/pantalon-madrid/', `<html><body>${chrome}${product}</body></html>`);
    expect(result.content).toContain('Pantalón corte palazzo');
    for (const text of ['Agregado al carrito', 'Ver carrito', 'Descuento exclusivo', 'Medios de pago', 'cupón', 'Elegí tu talle', 'Precio: menor a mayor', 'Más vendidos', 'Filtrar por', 'Talle S (82)']) {
      expect(result.content).not.toContain(text);
    }
  });

  it('keeps prose that merely mentions filters or a modal', () => {
    const prose = '<main><p>Our filters page explains how the modal dialog of the old site worked, in plain prose long enough.</p></main>';
    const result = extractPageFromHtml('https://example.com/about', `<html><body>${prose}</body></html>`);
    expect(result.content).toContain('Our filters page explains how the modal dialog');
  });
});

// Once the interface is gone, a listing is little more than its heading and a gift card is a title
// and a price. Pages that declare what they are stay indexable; the rest keep the general minimum.
describe('declared pages with short text', () => {
  const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
  const listed = [1, 2].map((i) => ld({ '@type': 'Product', name: `P${i}`, offers: { '@type': 'Offer', url: `https://shop.test/p/${i}/`, price: '10' } })).join('');

  it('indexes a listing whose own text is only its heading', () => {
    const result = extractPageFromHtml('https://shop.test/nueva-coleccion-la-muse/', `<html><head><title>La Muse</title></head><body>${listed}<div class="js-modal modal">¡Agregado al carrito!</div><h1>NUEVA COLECCIÓN - La Muse</h1></body></html>`);
    // Its own text is the heading; the products it declares follow (see listedProducts.test.ts).
    expect(result.content.startsWith('NUEVA COLECCIÓN - La Muse')).toBe(true);
    expect(result.content).not.toContain('Agregado al carrito');
    expect(result.indexable).toBe(true);
  });

  it('indexes a product with a price and a short description', () => {
    const html = `<html><head><meta property="product:price:amount" content="50000" /><meta property="product:price:currency" content="ARS" /></head><body><h1>Gift Card</h1><p>Elegí el monto.</p></body></html>`;
    const result = extractPageFromHtml('https://shop.test/productos/gift-card/', html);
    expect(result.metadata.price).toBe(50000);
    expect(result.indexable).toBe(true);
  });

  it('keeps the general minimum for a short page that declares nothing', () => {
    const result = extractPageFromHtml('https://shop.test/hola/', '<html><body><h1>Hola</h1><p>Bienvenida a la tienda.</p></body></html>');
    expect(result.indexable).toBe(false);
  });

  it('declaresOwnContent: a price or a listing, nothing else', () => {
    expect(declaresOwnContent({ price: 10 })).toBe(true);
    expect(declaresOwnContent({ observations: { pageType: 'collection' } })).toBe(true);
    expect(declaresOwnContent({ observations: { pageType: 'detail' } })).toBe(false);
    expect(declaresOwnContent({ price: '10' })).toBe(false);
    expect(declaresOwnContent(undefined)).toBe(false);
  });
});
