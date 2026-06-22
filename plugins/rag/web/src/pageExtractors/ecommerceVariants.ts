import { extractVariants, type VariantMetadata } from '../storefront';
import type { PageAttributeExtractor, PageExtractionResult } from './types';

/**
 * Built-in ecommerce variant extractor: colors/sizes/per-color images via the storefront pipeline
 * (schema.org baseline + PrestaShop/Shopify adapters + scope-aware widget heuristics).
 *
 * `detect()` is permissive (always attempts) because the storefront pipeline already self-gates:
 * it reads structured product data and lexicon-filtered real widgets, returning empty on non-product
 * pages. Hardening `detect()` to a structural score (platform signature / schema.org Product) is a
 * follow-up; today's empty-on-content-pages behavior is preserved either way.
 */
export const ecommerceVariantsExtractor: PageAttributeExtractor = {
  id: 'ecommerce-variants',

  detect() {
    return 1;
  },

  extract({ html, url }): PageExtractionResult {
    const v: VariantMetadata = extractVariants(html, url);
    const line = formatVariantLine(v);
    const metadata: Record<string, unknown> = {};
    if (v.colors.length > 0) metadata.colors = v.colors;
    if (v.sizes.length > 0) metadata.sizes = v.sizes;
    if (v.colorImages && Object.keys(v.colorImages).length > 0) metadata.colorImages = v.colorImages;
    if (v.platform) metadata.storefrontPlatform = v.platform;
    return { metadata, contentLines: line ? [line] : [] };
  },
};

/** Append the available colors/sizes to indexed content so they're searchable (bilingual label). */
export function formatVariantLine(v: VariantMetadata): string {
  const parts: string[] = [];
  if (v.colors.length > 0) parts.push(`Colores disponibles / available colors: ${v.colors.join(', ')}.`);
  if (v.sizes.length > 0) parts.push(`Tallas disponibles / available sizes: ${v.sizes.join(', ')}.`);
  return parts.join(' ');
}
