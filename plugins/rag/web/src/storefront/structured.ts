import type { StorefrontVariants } from './types';
import {
  CheerioRoot, COLOR_GROUP_RE, SIZE_GROUP_RE, asArray,
  decodeEntities, jsonNodes, pushVal, strip,
} from './shared';

/**
 * Platform-neutral structured-data extraction — the always-on baseline behind every storefront.
 *
 * Sources, low-noise and trusted as-is:
 *   1. schema.org JSON-LD Product (`color`, `size`, `additionalProperty`, `hasVariant`)
 *   2. microdata / OpenGraph (`itemprop="color"`, `product:color`)
 *   3. embedded JSON state (`"name":"Gris","group":"Color"` — PrestaShop/Shopify/Woo blobs)
 *
 * This intentionally does NOT scan DOM swatches/selects; those are noisy across the whole page
 * (related-product carousels) and belong in scope-aware platform adapters / the generic heuristic.
 */
export function extractStructured($: CheerioRoot, html: string): StorefrontVariants {
  const colors: string[] = [];
  const sizes: string[] = [];

  collectFromJsonLd($, colors, sizes);
  collectFromMicrodataAndOg($, colors);
  collectFromEmbeddedJson(html, colors, sizes);

  return { colors, sizes };
}

// ── schema.org JSON-LD ──────────────────────────────────────────────────────────
function collectFromJsonLd($: CheerioRoot, colors: string[], sizes: string[]): void {
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const node of jsonNodes(parsed)) {
      // Only trust color/size on a Product-like node — otherwise we'd read a stray `color` off
      // non-product JSON-LD (themes, breadcrumbs) on content sites.
      if (isProductLikeNode(node)) {
        pushVal(colors, node.color);
        pushVal(sizes, node.size);
        // additionalProperty: [{ name: 'Color', value: 'Gris' }, …]
        for (const prop of asArray(node.additionalProperty)) {
          if (!prop || typeof prop !== 'object') continue;
          const p = prop as Record<string, unknown>;
          const name = strip(String(p.name ?? ''));
          if (COLOR_GROUP_RE.test(name)) pushVal(colors, p.value);
          else if (SIZE_GROUP_RE.test(name)) pushVal(sizes, p.value);
        }
      }
      // ProductGroup variants. Their photos are read, scoped to the page's own product, by
      // `extractProductImages`.
      for (const v of [...asArray(node.hasVariant), ...asArray(node.model)]) {
        if (!v || typeof v !== 'object') continue;
        const vv = v as Record<string, unknown>;
        pushVal(colors, vv.color);
        pushVal(sizes, vv.size);
      }
    }
  });
}

/** A JSON-LD node that represents a product (or product group) — the only place color/size is real. */
function isProductLikeNode(node: Record<string, unknown>): boolean {
  const t = node['@type'];
  const types = Array.isArray(t) ? t : t != null ? [t] : [];
  if (types.some((x) => /product/i.test(String(x)))) return true;
  return node.hasVariant != null || node.offers != null || node.sku != null;
}

// ── microdata + OpenGraph ─────────────────────────────────────────────────────────
function collectFromMicrodataAndOg($: CheerioRoot, colors: string[]): void {
  $('[itemprop="color"]').each((_, el) => {
    pushVal(colors, $(el).attr('content') || $(el).text());
  });
  const og = $('meta[property="product:color"]').attr('content');
  if (og) pushVal(colors, og);
}

// ── embedded JSON state (PrestaShop / Shopify / Woo `"group":"Color"`) ──────────────
function collectFromEmbeddedJson(html: string, colors: string[], sizes: string[]): void {
  // PrestaShop-style: {"name":"Gris","group":"Color"} (also "Colour"/"Couleur"/"Tonalidad").
  // Only the GROUPED form is trusted — a bare `"color":"X"` matches theme/CSS/analytics JSON on any
  // site (e.g. a `"color":"black"` style token), which falsely tagged content pages as products.
  const grouped = /"name"\s*:\s*"([^"]{1,40})"\s*,\s*"group"\s*:\s*"([^"]{1,40})"/gi;
  let m: RegExpExecArray | null;
  while ((m = grouped.exec(html)) !== null) {
    const value = decodeEntities(m[1]);
    const group = strip(m[2]);
    if (COLOR_GROUP_RE.test(group)) pushVal(colors, value);
    else if (SIZE_GROUP_RE.test(group)) pushVal(sizes, value);
  }
}
