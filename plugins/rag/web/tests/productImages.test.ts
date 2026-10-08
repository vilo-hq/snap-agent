import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { extractProductImages, MAX_PRODUCT_IMAGES } from '../src/productImages';

const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
const PAGE = 'https://shop.test/productos/remera-lisa/';
const images = (html: string, colors: string[] = [], url = PAGE) => extractProductImages(cheerio.load(html), url, { colors });

/** A Tiendanube-shaped product page: one declared image, a gallery of thumbnails + slides, a carousel. */
function galleryPage(alts: string[], { name = 'Remera Lisa negro', page }: { name?: string; page?: unknown } = {}) {
  const srcset = (n: number) => `//cdn.test/p/remera-${n}-480-0.jpg 480w, //cdn.test/p/remera-${n}-1024-1024.jpg 1024w`;
  const thumbs = alts.map((alt, n) => `<a class="thumb"><img src="//cdn.test/placeholder.png" data-srcset="${srcset(n)}" alt="${alt}"></a>`).join('');
  const slides = alts.map((alt, n) => `<a class="slide"><img data-src="data:image/gif;base64,R0lGOD" data-srcset="${srcset(n)}" alt="${alt}"></a>`).join('');
  const carousel = ['Vestido Doma Verde Agua', 'Mono Flora Verde'].map((name, n) =>
    `<div class="item"><img data-srcset="//cdn.test/p/otro-${n}-480-0.jpg 480w" alt="${name}"></div>`).join('');
  return `<html><head>
    <meta property="og:title" content="${name}">
    <meta property="og:image" content="http://cdn.test/p/remera-0-640-0.jpg">
    ${ld(page ?? { '@type': 'WebPage', mainEntity: { '@type': 'Product', name, image: 'https://cdn.test/p/remera-0-480-0.jpg', offers: { price: '38900' } } })}
  </head><body>${thumbs}${slides}<section class="related">${carousel}</section></body></html>`;
}

describe('extractProductImages', () => {
  it('reads the gallery of the page product: one entry per photo, at its largest size, no carousel', () => {
    const out = images(galleryPage(['Remera Lisa negro', 'Remera Lisa negro - comprar online', 'Remera Lisa negro en internet']));
    expect(out).toEqual([
      { url: 'https://cdn.test/p/remera-0-1024-1024.jpg' },
      { url: 'https://cdn.test/p/remera-1-1024-1024.jpg' },
      { url: 'https://cdn.test/p/remera-2-1024-1024.jpg' },
    ]);
  });

  it('gives every photo the product colour when the product has only one', () => {
    const out = images(galleryPage(['Remera Lisa negro', 'Remera Lisa negro - frente']), ['Negro']);
    expect(out.map((image) => image.color)).toEqual(['Negro', 'Negro']);
  });

  it('takes a photo colour from its alt text only among the product colours, and only one', () => {
    const out = images(galleryPage([
      'Remera Lisa negro frente',
      'Remera Lisa blanco espalda',
      'Remera Lisa negro y blanco',
      'Remera Lisa azul detalle',
    ], { name: 'Remera Lisa' }), ['Negro', 'Blanco']);
    expect(out.map((image) => image.color)).toEqual(['Negro', 'Blanco', undefined, undefined]);
  });

  it('uses the declared variants as the photo list, each with its colour', () => {
    const variant = (color: string, size: string, photos: string[]) => ({ '@type': 'Product', color, size, image: photos, offers: { price: '14.99' } });
    const html = `<html><head>
      <meta property="og:image" content="https://shop.test/922604-large_default/vestido-midi.jpg">
      <meta property="og:image" content="https://shop.test/922683-large_default/vestido-midi.jpg">
      ${ld({ '@type': 'ProductGroup', name: 'Vestido midi', url: PAGE, hasVariant: [
        variant('Negro', 'S', ['https://shop.test/922604-large_default/a.jpg', 'https://shop.test/922683-large_default/a.jpg']),
        variant('Negro', 'M', ['https://shop.test/922604-large_default/a.jpg', 'https://shop.test/922683-large_default/a.jpg']),
        variant('Crudo', 'S', ['https://shop.test/931000-large_default/a.jpg']),
        variant('Crudo', 'M', ['https://shop.test/931000-large_default/a.jpg', 'https://shop.test/000001-large_default/a.jpg']),
        variant('Negro', 'L', ['https://shop.test/000001-large_default/a.jpg']),
      ] })}
    </head><body>
      <img src="https://shop.test/922604-medium_default/vestido-midi.jpg" alt="Vestido midi negro">
      <img src="https://shop.test/922604-large_default/vestido-midi.jpg" alt="Vestido midi negro">
    </body></html>`;
    expect(images(html, ['Negro', 'Crudo'])).toEqual([
      { url: 'https://shop.test/922604-large_default/a.jpg', color: 'Negro' },
      { url: 'https://shop.test/922683-large_default/a.jpg', color: 'Negro' },
      { url: 'https://shop.test/931000-large_default/a.jpg', color: 'Crudo' },
      // Declared under two colours: a photo of neither.
      { url: 'https://shop.test/000001-large_default/a.jpg' },
    ]);
  });

  it('keeps a photo of every colour past the cap, in page order', () => {
    const photos = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `https://shop.test/${prefix}-${i}.jpg`);
    const html = `<html><head>${ld({ '@type': 'ProductGroup', name: 'Camiseta', url: PAGE, hasVariant: [
      { '@type': 'Product', color: 'Arena', image: photos('arena', 10) },
      { '@type': 'Product', color: 'Negro', image: photos('negro', 2) },
    ] })}</head><body></body></html>`;
    const out = images(html, ['Arena', 'Negro']);
    expect(out).toHaveLength(MAX_PRODUCT_IMAGES);
    expect(out.filter((image) => image.color === 'Negro')).toEqual([{ url: 'https://shop.test/negro-0.jpg', color: 'Negro' }]);
    expect(out[0]).toEqual({ url: 'https://shop.test/arena-0.jpg', color: 'Arena' });
    expect(out[out.length - 1]!.color).toBe('Negro');
  });

  it('falls back to the og:image tags when the page lists no gallery', () => {
    const html = `<html><head>
      <meta property="og:type" content="product">
      <meta property="og:image" content="https://shop.test/a.jpg">
      <meta property="og:image" content="https://shop.test/b.jpg">
      <meta property="og:image" content="https://shop.test/logo.svg">
    </head><body><img src="https://shop.test/a.jpg"></body></html>`;
    expect(images(html)).toEqual([{ url: 'https://shop.test/a.jpg' }, { url: 'https://shop.test/b.jpg' }]);
  });

  it('gives a listing no photos', () => {
    const html = galleryPage(['Remera Lisa negro', 'Remera Lisa negro - frente'], { page: { '@type': 'CollectionPage', name: 'Remeras' } });
    expect(images(html, [], 'https://shop.test/remeras/')).toEqual([]);
  });

  it('gives a page without a product no photos, whatever its alt text says', () => {
    const html = `<html><head><meta property="og:type" content="website">
      <meta property="og:image" content="https://studio.test/phoenix.jpg"></head><body>
      <h1>Phoenix Office</h1><img src="https://studio.test/facade.jpg" alt="Black granite facade with Camelback Mountain view">
    </body></html>`;
    expect(images(html, [], 'https://studio.test/projects/phoenix')).toEqual([]);
  });
});
