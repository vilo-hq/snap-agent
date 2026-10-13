import { describe, it, expect } from 'vitest';
import { extractVariants } from '../src/storefront';
import {
  tiendanubePage, sizeFirstTheme, colorFirstTheme, singleGroupTheme, labelWithValueTheme, noOptionsTheme,
} from './fixtures/tiendanube';

describe('storefront framework — auto-detection + platform tag', () => {
  it('tags generic when no platform is detected but variants exist', () => {
    const html = `<html><body>
      <select name="color"><option>Elige</option><option>Rojo</option><option>Azul</option></select>
    </body></html>`;
    const v = extractVariants(html);
    expect(v.platform).toBe('generic');
    expect(v.colors).toEqual(expect.arrayContaining(['Rojo', 'Azul']));
  });

  it('extracts no colors from a non-product (content) page — no variant structure', () => {
    // Architecture firm project page: color words in prose / img alt / a theme JSON token, but no
    // product/variant structure. Must not be tagged as a product (the "Camelback" bug).
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"WebPage","name":"Phoenix Office"}</script>
      <script>window.theme = {"color":"black"};</script>
      </head><body>
      <h1>Example Studio Phoenix Office</h1>
      <p>A design drawing on the Sonoran Desert near Camelback Mountain, with black granite.</p>
      <img alt="Black granite facade with Camelback Mountain view" src="x.jpg"/>
    </body></html>`;
    const v = extractVariants(html, 'https://example.com/projects/phoenix');
    expect(v.colors).toEqual([]);
    expect(v.platform).toBeUndefined();
  });

  it('does not mis-tag the neckline word "redondo" as a color (red-stem collision)', () => {
    const html = `<html><body>
      <div class="product-colors"><span class="label-color">Gris</span></div>
      <img alt="Camiseta básica cuello redondo manga corta" />
    </body></html>`;
    const v = extractVariants(html);
    const lc = v.colors.map((c) => c.toLowerCase());
    expect(lc).toContain('gris');
    expect(lc).not.toContain('redondo'); // "red" prefix must not match "redondo"
  });

  it('captures per-color images from schema.org ProductGroup variants', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[
        {"@type":"Product","color":"Teal","image":"https://cdn.example.com/teal.jpg"},
        {"@type":"Product","color":"Navy","image":["https://cdn.example.com/navy.jpg"]}
      ]}</script></head><body></body></html>`;
    const v = extractVariants(html, 'https://shop.example.com/p');
    expect(v.colors.map((c) => c.toLowerCase())).toEqual(expect.arrayContaining(['teal', 'navy']));
    expect(v.images).toEqual([
      { url: 'https://cdn.example.com/teal.jpg', color: 'Teal' },
      { url: 'https://cdn.example.com/navy.jpg', color: 'Navy' },
    ]);
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

  it('takes no photo from the swatches (PrestaShop resolves variant images via AJAX)', () => {
    const v = extractVariants(html);
    expect(v.images).toBeUndefined();
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
    expect(v.images).toEqual([
      { url: 'https://cdn.shopify.com/black.jpg', color: 'Black' },
      { url: 'https://cdn.shopify.com/olive.jpg', color: 'Olive' },
    ]);
  });

  it('handles protocol-relative variant image URLs', () => {
    const proto = html.replace(/https:\/\/cdn\.shopify\.com/g, '//cdn.shopify.com');
    const v = extractVariants(proto, 'https://shop.example.com/products/tee');
    expect(v.images?.[0]).toEqual({ url: 'https://cdn.shopify.com/black.jpg', color: 'Black' });
  });
});

describe('Tiendanube adapter', () => {
  const url = 'https://tienda.example.com/productos/demo/';

  it('reads sizes and the colour of the main product when the theme puts size first', () => {
    const v = extractVariants(tiendanubePage(sizeFirstTheme), url);
    expect(v.platform).toBe('tiendanube');
    expect(v.sizes).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    expect(v.colors).toEqual(['Chocolate']);
    expect(v.variantRoles).toEqual({ Talle: 'size', Color: 'color' });
    expect(v.variants).toHaveLength(6);
    expect(v.variants?.every((x) => x.available)).toBe(true);
    expect(v.variants?.[2]).toEqual({ options: { Talle: 'M', Color: 'Chocolate' }, available: true });
  });

  it('takes roles from the group label, not the position, and leaves quick-shops out', () => {
    const v = extractVariants(tiendanubePage(colorFirstTheme), url);
    expect(v.colors).toEqual(['Celeste']);
    expect(v.sizes).toEqual(['S/M', 'L/XL']);
    expect(v.variantRoles).toEqual({ Color: 'color', Talle: 'size' });
  });

  it('marks a sold-out size as unavailable but still offers it', () => {
    const v = extractVariants(tiendanubePage(singleGroupTheme), url);
    expect(v.sizes).toEqual(['S', 'M']);
    expect(v.variants).toEqual([
      { options: { Talle: 'S' }, available: true },
      { options: { Talle: 'M' }, available: false },
    ]);
  });

  it('cuts the label at the colon and ignores the quick-shops of other products', () => {
    const v = extractVariants(tiendanubePage(labelWithValueTheme), url);
    expect(v.variantRoles).toEqual({ Talla: 'size' });
    expect(v.sizes).toEqual(['36', '38', '40', '42', '44', '46']);
    expect(v.variants?.filter((x) => !x.available).map((x) => x.options.Talla)).toEqual(['38', '40', '44', '46']);
    expect(v.colors).toEqual([]);
  });

  it('emits nothing for a product without options', () => {
    const v = extractVariants(tiendanubePage(noOptionsTheme), url);
    expect(v.platform).toBe('tiendanube');
    expect(v.colors).toEqual([]);
    expect(v.sizes).toEqual([]);
    expect(v.variants).toBeUndefined();
    expect(v.variantRoles).toBeUndefined();
  });

  it('keeps the gallery photos and declares none of the variant photos', () => {
    const v = extractVariants(tiendanubePage(sizeFirstTheme), url);
    expect(v.images).toEqual(Array.from({ length: 8 }, (_, i) => ({
      url: `https://acdn-us.mitiendanube.com/stores/000/001/products/demo-${i + 1}-1024-1024.jpg`,
      color: 'Chocolate',
    })));
  });
});

describe('Tiendanube adapter — edge cases', () => {
  const url = 'https://tienda.example.com/productos/demo/';
  const sizeGroup = (values: string[]) => [{ id: 0, labels: ['Talle'], values }];

  it('drops hidden variants, counts unmanaged stock as available, and gives contact variants no price', () => {
    const v = extractVariants(tiendanubePage({
      variants: [
        { option0: 'S', is_visible: false },
        { option0: 'M', stock: null, available: true },
        { option0: 'L', contact: true, price_number: null },
        { option0: 'XL' },
      ],
      groups: sizeGroup(['S', 'M', 'L', 'XL']),
    }), url);
    expect(v.sizes).toEqual(['M', 'L', 'XL']);
    expect(v.variants).toEqual([
      { options: { Talle: 'M' }, available: true },
      { options: { Talle: 'L' }, available: true, contact: true },
      { options: { Talle: 'XL' }, available: true },
    ]);
  });

  it('stores a price per variant only when prices differ, using price_number even on promotion', () => {
    const differ = extractVariants(tiendanubePage({
      variants: [
        { option0: '36', price_number: 49990, compare_at_price_number: 52990, has_promotional_price: true, promotional_price_number: null },
        { option0: '38', price_number: 45990 },
      ],
      groups: sizeGroup(['36', '38']),
    }), url);
    expect(differ.variants?.map((x) => x.price)).toEqual([49990, 45990]);

    const same = extractVariants(tiendanubePage({
      variants: [{ option0: '36', price_number: 49990 }, { option0: '38', price_number: 49990 }],
      groups: sizeGroup(['36', '38']),
    }), url);
    expect(same.variants?.some((x) => 'price' in x)).toBe(false);
  });

  it('keeps an option without a role under its label, out of colors and sizes', () => {
    const v = extractVariants(tiendanubePage({
      variants: [{ option0: 'M', option1: 'Rojo', option2: '2 metros' }],
      groups: [
        { id: 0, labels: ['Talle'], values: ['M'] },
        { id: 1, cls: 'js-color-variants-container', labels: ['Color'], values: ['Rojo'] },
        { id: 2, cls: 'no-colors', labels: ['Medida'], values: ['2 metros'] },
      ],
    }), url);
    expect(v.variants?.[0].options).toEqual({ Talle: 'M', Color: 'Rojo', Medida: '2 metros' });
    expect(v.variantRoles).toEqual({ Talle: 'size', Color: 'color' });
    expect(v.sizes).toEqual(['M']);
    expect(v.colors).toEqual(['Rojo']);
  });

  it('caps variants at 100 and says so', () => {
    const many = (n: number) => tiendanubePage({
      variants: Array.from({ length: n }, (_, i) => ({ option0: `T${i + 1}` })),
      groups: sizeGroup([]),
    });
    const cut = extractVariants(many(101), url);
    expect(cut.variants).toHaveLength(100);
    expect(cut.variantsTruncated).toBe(true);
    const whole = extractVariants(many(100), url);
    expect(whole.variants).toHaveLength(100);
    expect(whole).not.toHaveProperty('variantsTruncated');
  });

  it("falls back to the main container's data-variants when LS.variants is missing or broken", () => {
    const page = {
      mainVariants: [{ option0: 'S' }, { option0: 'M', available: false }],
      groups: sizeGroup(['S', 'M']),
      quickshops: [{
        variants: [{ option0: 'XXL', option1: 'Negro' }],
        groups: [
          { id: 0, labels: ['Talle'], values: ['XXL'] },
          { id: 1, cls: 'js-color-variants-container', labels: ['Color'], values: ['Negro'] },
        ],
      }],
    };
    for (const variants of [null, '[{"option0":"S",'] as const) {
      const v = extractVariants(tiendanubePage({ ...page, variants }), url);
      expect(v.sizes).toEqual(['S', 'M']);
      expect(v.colors).toEqual([]);
      expect(v.variants).toEqual([
        { options: { Talle: 'S' }, available: true },
        { options: { Talle: 'M' }, available: false },
      ]);
    }
  });

  it('takes the colour role from the group class when the group has no label', () => {
    const v = extractVariants(tiendanubePage({
      variants: [{ option0: 'Rojo', option1: 'Lisa' }],
      groups: [
        { id: 0, cls: 'js-color-variants-container', labels: [], values: ['Rojo'] },
        { id: 1, cls: 'no-colors', labels: [], values: ['Lisa'] },
      ],
    }), url);
    expect(v.colors).toEqual(['Rojo']);
    expect(v.sizes).toEqual([]);
    expect(v.variantRoles).toEqual({ Color: 'color' });
  });
});
