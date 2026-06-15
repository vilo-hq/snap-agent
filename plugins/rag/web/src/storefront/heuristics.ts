import type { StorefrontVariants } from './types';
import {
  CheerioRoot, CheerioScope, COLOR_GROUP_RE, SIZE_GROUP_RE, isColorLike, isSizeLike, pushVal,
} from './shared';

/**
 * Scope-aware swatch / <select> / alt-text heuristics for stores without usable structured data.
 *
 * Heuristic text is messy on real pages (concatenated sibling labels, size swatches in color
 * scopes, chat widgets) AND bleeds across the page (related-product carousels reuse the same swatch
 * markup), so:
 *   - every color candidate must pass the color lexicon, and
 *   - the caller passes a `scope` — platform adapters scope to the MAIN product form to avoid
 *     related-product bleed; the generic fallback scopes to the whole document.
 */
export function extractHeuristics($: CheerioRoot, scope: CheerioScope): StorefrontVariants {
  const colors: string[] = [];
  const sizes: string[] = [];

  const pushColorIf = (raw: unknown) => {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (s && s.length <= 30 && isColorLike(s)) pushVal(colors, s);
  };
  const ownText = (el: any) => $(el).clone().children().remove().end().text();

  // Leaf swatch labels (own text only) — route to size or color by what the label looks like.
  scope
    .find('.label-color, .color-texto, .label-size, [class*="swatch" i] .sr-only, [class*="variant" i] .sr-only, [class*="color" i] .sr-only, [data-color] .sr-only')
    .each((_, el) => {
      const t = ownText(el);
      if (isSizeLike(t)) pushVal(sizes, t);
      else pushColorIf(t);
    });

  // Swatch attributes → token-extract color words.
  scope
    .find('[class*="color" i][aria-label], [class*="swatch" i][aria-label], [data-color], [data-colour], [class*="color" i][title], [title][class*="variant" i]')
    .each((_, el) => {
      const v =
        $(el).attr('aria-label') || $(el).attr('title') ||
        $(el).attr('data-color') || $(el).attr('data-colour') || '';
      // A whole color name first (handles "Gris Oscuro"); then fall back to tokens.
      pushColorIf(v);
      for (const tok of v.split(/[\s,/-]+/)) pushColorIf(tok);
    });

  // <select> color/size pickers.
  scope.find('select').each((_, sel) => {
    const ctx = `${$(sel).attr('name') ?? ''} ${$(sel).attr('id') ?? ''} ${$(sel).attr('aria-label') ?? ''}`;
    const isColor = COLOR_GROUP_RE.test(ctx);
    const isSize = SIZE_GROUP_RE.test(ctx);
    if (!isColor && !isSize) return;
    $(sel)
      .find('option')
      .each((__, opt) => {
        const v = $(opt).text().trim();
        if (!v || /^(?:elige|select|choose|--)/i.test(v.toLowerCase())) return;
        if (isColor) pushColorIf(v);
        else if (isSizeLike(v)) pushVal(sizes, v);
      });
  });

  // Image alt/title often encodes the visible variant color ("… gris vista frontal").
  scope.find('img[alt], img[title]').each((_, el) => {
    const alt = $(el).attr('alt') || $(el).attr('title') || '';
    for (const token of alt.split(/[\s,/-]+/)) {
      if (token.length >= 3) pushColorIf(token);
    }
  });

  // Sizes also live in plain swatch buttons (S/M/L/XL).
  scope.find('[class*="size" i] *, [class*="talla" i] *, [data-size]').each((_, el) => {
    const v = ($(el).attr('data-size') || ownText(el)).trim();
    if (isSizeLike(v)) pushVal(sizes, v);
  });

  return { colors, sizes };
}
