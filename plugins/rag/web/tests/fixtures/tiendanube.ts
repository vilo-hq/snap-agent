/**
 * Tiendanube product pages, reduced to the structure the adapter reads, with neutral names.
 *
 * Shapes taken from five real store pages (measured 2026-10-13): `LS.variants` set once by the
 * platform's base script, the main `.js-product-container` (`#single-product`, or
 * `#single-product-container` in one theme) with its `data-variants` and its
 * `.js-product-variants-group[data-variation-id=N]` groups, and quick-shops of OTHER products
 * (`.js-product-container.js-quickshop-container`) with their own `data-variants` and groups.
 */

export interface TnVariant {
  option0?: string | null;
  option1?: string | null;
  option2?: string | null;
  available?: boolean;
  stock?: number | null;
  is_visible?: boolean;
  contact?: boolean;
  price_number?: number | null;
  compare_at_price_number?: number | null;
  has_promotional_price?: boolean;
  promotional_price_number?: number | null;
  image_url?: string;
}

export interface TnGroup {
  id: number;
  /** Extra classes on the group (`js-color-variants-container`, `no-colors`). */
  cls?: string;
  /** `<label>`s inside the group, in order. */
  labels: string[];
  values: string[];
}

export interface TnPage {
  /** `LS.variants`. `null` leaves it out; a string is written as-is (broken JSON). */
  variants: TnVariant[] | string | null;
  groups: TnGroup[];
  /** The main container's `data-variants`; defaults to `variants`. */
  mainVariants?: TnVariant[];
  mainId?: string;
  quickshops?: Array<{ variants: TnVariant[]; groups: TnGroup[] }>;
  productName?: string;
  /** Gallery photo URLs (protocol-relative), rendered as lazy `<img>` naming the product. */
  gallery?: string[];
}

export function variant(v: TnVariant): Record<string, unknown> {
  return {
    product_id: 1,
    price_number: 10000,
    compare_at_price_number: null,
    has_promotional_price: false,
    promotional_price_number: null,
    stock: 5,
    available: true,
    is_visible: true,
    contact: false,
    option0: null,
    option1: null,
    option2: null,
    image_url: '//acdn-us.mitiendanube.com/stores/000/001/products/variant-photo-1024-1024.jpg',
    ...v,
  };
}

const attr = (json: string) => json.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function group(g: TnGroup): string {
  return `<div class="js-product-variants-group ${g.cls ?? ''}" data-variation-id="${g.id}">
    ${g.labels.map((l) => `<label class="form-label">${l}</label>`).join('\n    ')}
    <select class="js-variation-option" name="variation[${g.id}]">
      ${g.values.map((v) => `<option value="${v}">${v}</option>`).join('')}
    </select>
    ${g.values.map((v) => `<a data-option="${v}" class="js-insta-variant btn btn-variant" title="${v}"><span data-name="${v}">${v}</span></a>`).join('')}
  </div>`;
}

export function tiendanubePage(p: TnPage): string {
  const name = p.productName ?? 'Prenda Demo';
  const ls = p.variants === null
    ? ''
    : `LS.variants = ${typeof p.variants === 'string' ? p.variants : JSON.stringify(p.variants.map(variant))};`;
  const main = p.mainVariants ?? (Array.isArray(p.variants) ? p.variants : []);
  const gallery = (p.gallery ?? []).map((src) =>
    `<img src="//acdn-us.mitiendanube.com/assets/themes/demo/static/images/empty-placeholder.png" data-srcset='${src}-480-0.jpg 480w, ${src}-1024-1024.jpg 1024w' class="lazyload" alt="${name} - comprar online" />`,
  ).join('\n');
  return `<!DOCTYPE html><html><head>
  <meta property="og:type" content="tiendanube:product" />
  <meta property="og:title" content="${name}" />
  <script type="application/ld+json">{"@type":"Product","name":"${name}","sku":"DEMO1","offers":{"@type":"Offer","price":"10000","priceCurrency":"ARS"}}</script>
  <script src="//acdn-us.mitiendanube.com/assets/stores/demo/main.js"></script>
  </head><body>
  <script>
    var LS = LS || {};
    LS.store = { id: 1, url: 'tienda.example.com' };
    ${ls}
  </script>
  <div id="${p.mainId ?? 'single-product'}" class="js-product-detail js-product-container" data-variants="${attr(JSON.stringify(main.map(variant)))}">
    ${gallery}
    <h1>${name}</h1>
    <form>
      ${p.groups.map(group).join('\n')}
      <label>Cantidad</label><input type="number" value="1" />
    </form>
  </div>
  <section class="related">
    ${(p.quickshops ?? []).map((q) => `<div class="js-product-container js-quickshop-container" data-variants="${attr(JSON.stringify(q.variants.map(variant)))}">
      ${q.groups.map(group).join('\n')}
    </div>`).join('\n')}
  </section>
  </body></html>`;
}

const sizesXsXxl = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

/** Size first (`option0`), one colour declared with a trailing period, eight gallery photos. */
export const sizeFirstTheme: TnPage = {
  productName: 'Pantalon Demo Marron',
  variants: sizesXsXxl.map((s) => ({ option0: s, option1: 'Chocolate.' })),
  groups: [
    { id: 0, labels: ['Talle', 'Talle'], values: sizesXsXxl },
    { id: 1, cls: 'js-color-variants-container', labels: ['Color', 'Color'], values: ['Chocolate.'] },
  ],
  gallery: Array.from({ length: 8 }, (_, i) => `//acdn-us.mitiendanube.com/stores/000/001/products/demo-${i + 1}`),
};

/** Colour first (`option0`), combined sizes, a third «Seleccionar variante» label, a black quick-shop. */
export const colorFirstTheme: TnPage = {
  variants: [
    { option0: 'Celeste', option1: 'S/M' },
    { option0: 'Celeste', option1: 'L/XL' },
  ],
  groups: [
    { id: 0, cls: 'js-color-variants-container', labels: ['Color ', 'Seleccionar variante'], values: ['Celeste'] },
    { id: 1, cls: 'no-colors', labels: ['Talle ', 'Seleccionar variante'], values: ['S/M', 'L/XL'] },
  ],
  quickshops: [{
    variants: [{ option0: 'Negro', option1: 'S/M' }, { option0: 'Negro', option1: 'L/XL' }],
    groups: [
      { id: 0, cls: 'js-color-variants-container', labels: ['Color ', 'Seleccionar variante'], values: ['Negro'] },
      { id: 1, cls: 'no-colors', labels: ['Talle ', 'Seleccionar variante'], values: ['S/M', 'L/XL'] },
    ],
  }],
};

/** One size group, M sold out. */
export const singleGroupTheme: TnPage = {
  variants: [
    { option0: 'S', stock: 1 },
    { option0: 'M', stock: 0, available: false },
  ],
  groups: [{ id: 0, labels: ['Talle'], values: ['S', 'M'] }],
  quickshops: [{
    variants: [{ option0: 'XL' }],
    groups: [{ id: 0, labels: ['Talle'], values: ['XL'] }],
  }],
};

/** Label «Talla: 36» (selected value inline), 4 of 6 sold out, eight quick-shops of other jeans. */
export const labelWithValueTheme: TnPage = {
  mainId: 'single-product-container',
  variants: [
    { option0: '36', stock: 2 },
    { option0: '38', stock: 0, available: false },
    { option0: '40', stock: 0, available: false },
    { option0: '42', stock: 4 },
    { option0: '44', stock: 0, available: false },
    { option0: '46', stock: 0, available: false },
  ].map((v) => ({
    ...v,
    price_number: 49990,
    compare_at_price_number: 52990,
    has_promotional_price: true,
    promotional_price_number: null,
  })),
  groups: [{ id: 0, labels: ['Talla: <strong>36</strong>'], values: ['36', '38', '40', '42', '44', '46'] }],
  quickshops: Array.from({ length: 8 }, (_, i) => ({
    variants: [{ option0: String(50 + i * 2) }],
    groups: [{ id: 0, labels: [`Talla: <strong>${50 + i * 2}</strong>`], values: [String(50 + i * 2)] }],
  })),
};

/** No options at all (a rug), with quick-shops of sibling products. */
export const noOptionsTheme: TnPage = {
  variants: [{ stock: 121 }],
  groups: [],
  quickshops: [{ variants: [{ stock: 3 }], groups: [] }],
};
