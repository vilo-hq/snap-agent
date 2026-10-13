import type { ProductVariant, StorefrontExtractor, StorefrontVariants, VariantRole } from './types';
import type { CheerioRoot } from './shared';

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
    if (/mitiendanube\.com/i.test(html)) score += 1;
    return score;
  },

  extract(html: string, $: CheerioRoot): StorefrontVariants {
    const raw = readLsVariants(html) ?? [];
    const main = $('.js-product-container').not('.js-quickshop-container').first();

    const names = new Map<number, string>();
    main.find('.js-product-variants-group').each((_, el) => {
      const group = $(el);
      const id = Number(group.attr('data-variation-id'));
      const label = group.find('label').toArray()
        .map((l) => $(l).text().split(':')[0].trim())
        .find(Boolean);
      if (Number.isInteger(id) && label) names.set(id, label);
    });

    const roles: Record<string, VariantRole> = {};
    const colors: string[] = [];
    const sizes: string[] = [];
    const variants: ProductVariant[] = [];
    for (const v of raw) {
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
      variants.push({ options, available: v.available === true });
    }

    if (variants.length === 0) return { colors: [], sizes: [] };
    return { colors, sizes, variants, variantRoles: roles };
  },
};

function roleOf(name: string): VariantRole | undefined {
  if (/colou?r/i.test(name)) return 'color';
  if (/talle|talla|size|tama/i.test(name)) return 'size';
  return undefined;
}

/** Trim and drop a trailing period («Chocolate.»). */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\.$/, '').trim() : '';
}

function readLsVariants(html: string): Record<string, unknown>[] | undefined {
  const match = html.match(/LS\.variants\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
