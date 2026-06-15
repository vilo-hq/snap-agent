import { describe, it, expect } from 'vitest';
import { extractVariants } from '../src/storefront';

describe('storefront framework — auto-detection + platform tag', () => {
  it('tags generic when no platform is detected but variants exist', () => {
    const html = `<html><body>
      <select name="color"><option>Elige</option><option>Rojo</option><option>Azul</option></select>
    </body></html>`;
    const v = extractVariants(html);
    expect(v.platform).toBe('generic');
    expect(v.colors).toEqual(expect.arrayContaining(['Rojo', 'Azul']));
  });

  it('captures per-color images from schema.org ProductGroup variants', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[
        {"@type":"Product","color":"Teal","image":"https://cdn.example.com/teal.jpg"},
        {"@type":"Product","color":"Navy","image":["https://cdn.example.com/navy.jpg"]}
      ]}</script></head><body></body></html>`;
    const v = extractVariants(html, 'https://shop.example.com/p');
    expect(v.colors.map((c) => c.toLowerCase())).toEqual(expect.arrayContaining(['teal', 'navy']));
    expect(v.colorImages).toMatchObject({
      teal: 'https://cdn.example.com/teal.jpg',
      navy: 'https://cdn.example.com/navy.jpg',
    });
  });
});

describe('PrestaShop adapter', () => {
  // Main product form + a related-products carousel that reuses the color-swatch markup.
  const html = `<!DOCTYPE html><html><head>
    <meta name="generator" content="PrestaShop 1.7.8">
    </head><body>
    <form id="add-to-cart-or-refresh">
      <div class="product-variants">
        <span class="label-color">Gris</span>
        <span class="label-color">Negro</span>
      </div>
      <div class="product-quantity"><select name="talla"><option>Talla</option><option>S</option><option>M</option></select></div>
    </form>
    <section class="product-accessories">
      <a class="color" title="Rojo"></a>
      <a class="color" title="Verde Agua"></a>
      <a class="color" title="Ocre"></a>
    </section>
  </body></html>`;

  it('detects PrestaShop and scopes colors to the main product (no related-product bleed)', () => {
    const v = extractVariants(html, 'https://shop.example.com/es/p/1-2');
    expect(v.platform).toBe('prestashop');
    const lc = v.colors.map((c) => c.toLowerCase());
    expect(lc).toEqual(expect.arrayContaining(['gris', 'negro']));
    // Related-product colors must NOT leak in.
    expect(lc).not.toContain('rojo');
    expect(lc).not.toContain('verde agua');
    expect(lc).not.toContain('ocre');
    expect(v.sizes).toEqual(expect.arrayContaining(['S', 'M']));
  });

  it('leaves colorImages empty for PrestaShop (variant images are AJAX-resolved)', () => {
    const v = extractVariants(html);
    expect(v.colorImages ?? {}).toEqual({});
  });
});

describe('Shopify adapter', () => {
  const html = `<!DOCTYPE html><html><head>
    <script src="//cdn.shopify.com/s/files/theme.js"></script>
    </head><body>
    <script type="application/json" data-product-json>{
      "options":[{"name":"Color","values":["Black","Olive"]},{"name":"Size","values":["S","M"]}],
      "variants":[
        {"option1":"Black","option2":"S","featured_image":{"src":"https://cdn.shopify.com/black.jpg"}},
        {"option1":"Olive","option2":"M","featured_image":{"src":"https://cdn.shopify.com/olive.jpg"}}
      ]
    }</script>
  </body></html>`;

  it('detects Shopify and reads colors, sizes, and per-color images from the product JSON', () => {
    const v = extractVariants(html, 'https://shop.example.com/products/tee');
    expect(v.platform).toBe('shopify');
    expect(v.colors).toEqual(expect.arrayContaining(['Black', 'Olive']));
    expect(v.sizes).toEqual(expect.arrayContaining(['S', 'M']));
    expect(v.colorImages).toMatchObject({
      black: 'https://cdn.shopify.com/black.jpg',
      olive: 'https://cdn.shopify.com/olive.jpg',
    });
  });

  it('handles protocol-relative variant image URLs', () => {
    const proto = html.replace(/https:\/\/cdn\.shopify\.com/g, '//cdn.shopify.com');
    const v = extractVariants(proto, 'https://shop.example.com/products/tee');
    expect(v.colorImages?.black).toBe('https://cdn.shopify.com/black.jpg');
  });
});
