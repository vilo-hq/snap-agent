import type { StorefrontExtractor, StorefrontVariants } from './types';
import {
  CheerioRoot, COLOR_GROUP_RE, SIZE_GROUP_RE, absoluteUrl, asArray, colorKey, pushVal,
} from './shared';

/**
 * Shopify adapter.
 *
 * Shopify themes embed the full product object as JSON (`[data-product-json]`, a `application/json`
 * script, or `ShopifyAnalytics.meta`). That object carries `options` (Color/Size) and `variants`
 * with a per-variant `featured_image` — so unlike PrestaShop, Shopify exposes a static color→image
 * map, which we capture into `colorImages` to drive right-color card images.
 */
export const shopifyExtractor: StorefrontExtractor = {
  platform: 'shopify',

  detect(html: string, $: CheerioRoot): number {
    let score = 0;
    if (/cdn\.shopify\.com/i.test(html)) score += 2;
    if (/Shopify\.theme|window\.Shopify\b|ShopifyAnalytics/.test(html)) score += 2;
    if ($('[data-product-json], [data-product-handle]').length > 0) score += 2;
    if (/\.myshopify\.com/i.test(html)) score += 1;
    return score;
  },

  extract(html: string, $: CheerioRoot, pageUrl?: string): StorefrontVariants {
    const product = findProductJson($, html);
    if (!product) return { colors: [], sizes: [], colorImages: {} };

    const options = normalizeOptions(product.options);
    const colorIdx = options.findIndex((o) => COLOR_GROUP_RE.test(o.name));
    const sizeIdx = options.findIndex((o) => SIZE_GROUP_RE.test(o.name));

    const colors: string[] = [];
    const sizes: string[] = [];
    const colorImages: Record<string, string> = {};

    // Prefer the declared option value lists (clean, ordered).
    if (colorIdx >= 0) pushVal(colors, options[colorIdx].values);
    if (sizeIdx >= 0) pushVal(sizes, options[sizeIdx].values);

    for (const variant of asArray(product.variants)) {
      if (!variant || typeof variant !== 'object') continue;
      const v = variant as Record<string, unknown>;
      const opts = variantOptionValues(v, options.length);
      const color = colorIdx >= 0 ? opts[colorIdx] : undefined;
      const size = sizeIdx >= 0 ? opts[sizeIdx] : undefined;
      if (color) pushVal(colors, color);
      if (size) pushVal(sizes, size);
      if (color) {
        const src = variantImage(v);
        const abs = absoluteUrl(src, pageUrl);
        if (abs) {
          const key = colorKey(color);
          if (key && !colorImages[key]) colorImages[key] = abs;
        }
      }
    }

    return { colors, sizes, colorImages };
  },
};

type NormalizedOption = { name: string; values: string[] };

/** `options` may be `["Color","Size"]` or `[{name,values}]`; normalize to a common shape. */
function normalizeOptions(options: unknown): NormalizedOption[] {
  return asArray(options).map((o, i) => {
    if (typeof o === 'string') return { name: o, values: [] };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const name = String(obj.name ?? obj.title ?? `option${i + 1}`);
      const values = asArray(obj.values).map((x) => String(x)).filter(Boolean);
      return { name, values };
    }
    return { name: `option${i + 1}`, values: [] };
  });
}

/** A variant's option values, from `options:[…]` or `option1/2/3`. */
function variantOptionValues(v: Record<string, unknown>, count: number): (string | undefined)[] {
  if (Array.isArray(v.options)) return v.options.map((x) => (x == null ? undefined : String(x)));
  const out: (string | undefined)[] = [];
  for (let i = 1; i <= Math.max(count, 3); i++) {
    const val = v[`option${i}`];
    out.push(val == null ? undefined : String(val));
  }
  return out;
}

/** featured_image may be a `{src}` object, a string, or nested under featured_media. */
function variantImage(v: Record<string, unknown>): string | undefined {
  const fi = v.featured_image;
  if (typeof fi === 'string' && fi.trim()) return fi.trim();
  if (fi && typeof fi === 'object') {
    const src = (fi as Record<string, unknown>).src;
    if (typeof src === 'string' && src.trim()) return src.trim();
  }
  const fm = v.featured_media;
  if (fm && typeof fm === 'object') {
    const preview = (fm as Record<string, unknown>).preview_image;
    if (preview && typeof preview === 'object') {
      const src = (preview as Record<string, unknown>).src;
      if (typeof src === 'string' && src.trim()) return src.trim();
    }
  }
  return undefined;
}

/** Locate the product JSON across the common Shopify embedding spots. */
function findProductJson($: CheerioRoot, html: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  $('script[type="application/json"], [data-product-json]').each((_, el) => {
    const raw = $(el).html();
    if (raw && raw.includes('"variants"')) candidates.push(raw);
  });
  // ShopifyAnalytics.meta = {"product":{...}} (no images, but a usable last resort).
  const metaMatch = html.match(/var\s+meta\s*=\s*(\{.+?\});\s*\n/s);
  if (metaMatch) candidates.push(metaMatch[1]);

  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const product = unwrapProduct(parsed);
    if (product) return product;
  }
  return null;
}

/** Accept either a Product object directly or a wrapper like `{product:{…}}`. */
function unwrapProduct(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.variants)) return obj;
  if (obj.product && typeof obj.product === 'object') {
    const p = obj.product as Record<string, unknown>;
    if (Array.isArray(p.variants)) return p;
  }
  return null;
}
