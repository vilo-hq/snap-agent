import type { StorefrontExtractor, StorefrontVariants } from './types';
import type { CheerioRoot, CheerioScope } from './shared';
import { extractHeuristics } from './heuristics';

/**
 * PrestaShop adapter.
 *
 * Value over the generic fallback: PrestaShop pages embed related-product carousels that reuse the
 * same color-swatch markup, so a whole-page swatch scan bleeds other products' colors into the
 * result. This adapter scopes the swatch/size heuristics to the MAIN product form
 * (`#add-to-cart-or-refresh`), which is unique per page across PrestaShop themes.
 *
 * NOTE on images: PrestaShop swaps the per-color image via an AJAX call (the swatch carries only a
 * combination id, not an image URL), so a static crawl cannot build a color→image map here.
 * `colorImages` is therefore left empty; fixing the per-color card image for PrestaShop needs a
 * crawler-level variant fetch (tracked as a follow-up), not this extractor.
 */
export const prestashopExtractor: StorefrontExtractor = {
  platform: 'prestashop',

  detect(html: string, $: CheerioRoot): number {
    let score = 0;
    if (/content=["']PrestaShop/i.test(html)) score += 3;
    if (/var\s+prestashop\b|window\.prestashop\b|"prestashop"\s*:/.test(html)) score += 2;
    if ($('[data-product]').length > 0 && /id_product_attribute|combinations/i.test(html)) score += 2;
    if (/\/modules\/ps_|prestashop/i.test(html)) score += 1;
    return score;
  },

  extract(_html: string, $: CheerioRoot, _pageUrl?: string): StorefrontVariants {
    const scope = mainProductScope($);
    const { colors, sizes } = extractHeuristics($, scope);
    return { colors, sizes, colorImages: {} };
  },
};

/** The main product's add-to-cart form — unique per page; isolates it from related-product blocks. */
function mainProductScope($: CheerioRoot): CheerioScope {
  for (const sel of [
    '#add-to-cart-or-refresh',
    '.product-actions',
    '.product-add-to-cart',
    '.product-information',
    '.product-variants',
  ]) {
    const el = $(sel).first();
    if (el.length > 0) {
      // Climb to the enclosing product form/section so we also see the size group + cover alt.
      const form = el.closest('form, .product-information, .product-container, #main');
      return form.length > 0 ? form : el;
    }
  }
  return $('body');
}
