import type { ProductVariant, StorefrontExtractor, StorefrontVariants, VariantRole } from './types';
import type { CheerioRoot } from './shared';

/** Enough for a product's real combinations; Tiendanube allows up to 999. Past it, `variantsTruncated`. */
export const MAX_VARIANTS = 100;

/**
 * Tiendanube (Nuvemshop) adapter.
 *
 * The platform's base script (not the theme) sets `LS.variants` once per page, for the main product:
 * every combination with `option0-2`, `available` and `price_number`. Quick-shops of other products
 * carry their own `data-variants` on `.js-product-container.js-quickshop-container`, which a
 * whole-page scan reads as this product's colours, so they are never read.
 *
 * Which option is the size and which the colour depends on the theme (option0 is the size in one,
 * the colour in another), so the role comes from the label of the option's group inside the main
 * container, never from the position. Values are taken as the store declares them (`S/M` is a size),
 * not through the size/colour lexicons.
 *
 * Measured 2026-10-13 on five stores, four themes: without this adapter the pipeline read no size on
 * four of them and a quick-shop's colour on another.
 */
export const tiendanubeExtractor: StorefrontExtractor = {
  platform: 'tiendanube',

  detect(html: string, $: CheerioRoot): number {
    let score = 0;
    if ($('meta[property="og:type"]').attr('content') === 'tiendanube:product') score += 3;
    if (/LS\.variants\s*=/.test(html)) score += 3;
    // The CDN alone is not enough: any page linking to mitiendanube.com would win and switch off
    // the generic heuristics. It only adds confidence on top of a real signal.
    if (score > 0 && /mitiendanube\.com/i.test(html)) score += 1;
    return score;
  },

  extract(html: string, $: CheerioRoot): StorefrontVariants {
    const main = $('.js-product-container').not('.js-quickshop-container').first();
    // `data-variants` of the main container only: the quick-shops carry other products' variants.
    const raw = parseVariants(html.match(/LS\.variants\s*=\s*(\[[\s\S]*?\]);/)?.[1])
      ?? parseVariants(main.attr('data-variants'))
      ?? [];

    const names = new Map<number, string>();
    main.find('.js-product-variants-group').each((_, el) => {
      const group = $(el);
      const id = Number(group.attr('data-variation-id'));
      const label = group.find('label').toArray()
        .map((l) => $(l).text().split(':')[0].trim())
        .find(Boolean);
      // No label: the theme's colour-swatch class still says it is the colour.
      const name = label || (group.hasClass('js-color-variants-container') ? 'Color' : undefined);
      if (Number.isInteger(id) && name) names.set(id, name);
    });

    const roles: Record<string, VariantRole> = {};
    const colors: string[] = [];
    const sizes: string[] = [];
    const variants: ProductVariant[] = [];
    const visible = raw.filter((v) => v.is_visible !== false);
    const priced = visible.filter((v) => v.contact !== true && typeof v.price_number === 'number');
    const pricesDiffer = new Set(priced.map((v) => v.price_number)).size > 1;
    for (const v of visible) {
      const options: Record<string, string> = {};
      for (const i of [0, 1, 2]) {
        const value = clean(v[`option${i}`]);
        if (!value) continue;
        const name = names.get(i) ?? `option${i}`;
        options[name] = value;
        const role = roleOf(name);
        if (!role) continue;
        roles[name] = role;
        (role === 'color' ? colors : sizes).push(value);
      }
      if (Object.keys(options).length === 0) continue;
      // `price_number` is the price charged, also on promotion (compare_at is the struck-out one).
      const variant: ProductVariant = { options, available: v.available === true };
      if (v.contact === true) variant.contact = true;
      else if (pricesDiffer && typeof v.price_number === 'number') variant.price = v.price_number;
      variants.push(variant);
    }

    if (variants.length === 0) return { colors: [], sizes: [] };
    const result: StorefrontVariants = { colors, sizes, variants: variants.slice(0, MAX_VARIANTS), variantRoles: roles };
    if (variants.length > MAX_VARIANTS) result.variantsTruncated = true;
    return result;
  },
};

// Tiendanube property names are free text («Gama», «Corte», «Estampa»), so the role comes from the
// spec's own lexicon, matched per word — not from the shared COLOR_GROUP_RE / SIZE_GROUP_RE, whose
// substrings (`cor`, `gama`) would turn product lines and cuts into colours. Colour = whole word
// (+ plural); size = word prefix (`tama` → «Tamaño»).
const COLOR_WORD_RE = /^colou?r(?:es|s)?$/i;
const SIZE_WORD_RE = /^(?:talle|talla|size|tama)/i;

function roleOf(name: string): VariantRole | undefined {
  const words = name.split(/[^\p{L}]+/u).filter(Boolean);
  if (words.some((w) => COLOR_WORD_RE.test(w))) return 'color';
  if (words.some((w) => SIZE_WORD_RE.test(w))) return 'size';
  return undefined;
}

/** Trim and drop a trailing period («Chocolate.»). */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\.$/, '').trim() : '';
}

function parseVariants(json: string | undefined): Record<string, unknown>[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
