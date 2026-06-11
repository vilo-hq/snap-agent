import { describe, it, expect } from 'vitest';
import { extractVariants } from '../src/variantMetadata';
import { extractPageFromHtml } from '../src/htmlPageExtract';

describe('extractVariants', () => {
  it('reads colors/sizes from schema.org JSON-LD (Product + additionalProperty)', () => {
    const html = `<html><head>
      <script type="application/ld+json">{
        "@type":"Product","name":"Tee","color":"Green",
        "additionalProperty":[{"@type":"PropertyValue","name":"Color","value":"Navy"}],
        "hasVariant":[{"@type":"Product","color":"Olive","size":"M"}]
      }</script>
    </head><body></body></html>`;
    const v = extractVariants(html);
    expect(v.colors.map((c) => c.toLowerCase())).toEqual(expect.arrayContaining(['green', 'navy', 'olive']));
    expect(v.sizes).toContain('M');
  });

  it('reads PrestaShop-style embedded JSON ("group":"Color")', () => {
    const html = `<html><body><script>var p = {"combinations":[
      {"name":"Gris","group":"Color"},{"name":"Verde Mar","group":"Color"},
      {"name":"L","group":"Talla"}]};</script></body></html>`;
    const v = extractVariants(html);
    expect(v.colors).toEqual(expect.arrayContaining(['Gris', 'Verde Mar']));
    expect(v.sizes).toContain('L');
  });

  it('reads colors from a swatch widget and lexicon-filtered alt text', () => {
    const html = `<html><body>
      <div class="product-colors">
        <span class="sr-only">Beige</span><span class="label-color">Gris Oscuro</span>
      </div>
      <img alt="Camiseta básica verde vista frontal" />
      <img alt="Modelo posando con estilo" />
    </body></html>`;
    const v = extractVariants(html);
    const lc = v.colors.map((c) => c.toLowerCase());
    expect(lc).toEqual(expect.arrayContaining(['beige', 'gris oscuro', 'verde']));
    // "Modelo"/"posando"/"estilo" are not colors → not captured.
    expect(lc).not.toContain('modelo');
  });

  it('reads <select> options when the select is a color/size picker', () => {
    const html = `<html><body>
      <select name="color"><option>Elige color</option><option>Rojo</option><option>Azul</option></select>
      <select name="talla"><option>Talla</option><option>S</option><option>XL</option></select>
    </body></html>`;
    const v = extractVariants(html);
    expect(v.colors).toEqual(expect.arrayContaining(['Rojo', 'Azul']));
    expect(v.sizes).toEqual(expect.arrayContaining(['S', 'XL']));
  });

  it('returns empty for a non-product page', () => {
    const v = extractVariants('<html><body><article><p>A blog post about gardening.</p></article></body></html>');
    expect(v.colors).toEqual([]);
    expect(v.sizes).toEqual([]);
  });
});

describe('extractPageFromHtml — variant enrichment', () => {
  const html = `<!DOCTYPE html><html><head><title>Camiseta</title></head><body>
    <main><h1>Camiseta básica</h1><p>${'Camiseta de algodón muy cómoda y básica para el día a día. '.repeat(2)}</p>
      <div class="product-variants"><span class="label-color">Verde Mar</span><span class="label-color">Gris</span></div>
    </main></body></html>`;

  it('appends colors to indexed content and stores them in metadata', () => {
    const r = extractPageFromHtml('https://shop.example.com/p', html, { defaultType: 'product' });
    expect(r.content).toMatch(/available colors:.*(verde mar|gris)/i);
    expect(r.metadata.colors).toEqual(expect.arrayContaining(['Verde Mar', 'Gris']));
  });

  it('is skippable via extractVariantMetadata:false', () => {
    const r = extractPageFromHtml('https://shop.example.com/p', html, { extractVariantMetadata: false });
    expect(r.content).not.toMatch(/available colors/i);
    expect(r.metadata.colors).toBeUndefined();
  });
});
