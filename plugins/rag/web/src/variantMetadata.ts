/**
 * Variant (color / size / per-color image) extraction.
 *
 * Implementation moved to the auto-detected storefront extractor framework in `./storefront`
 * (schema.org/structured baseline + PrestaShop/Shopify adapters). This module re-exports the public
 * surface so existing imports keep working.
 */
export { extractVariants, type VariantMetadata } from './storefront';
export type { StorefrontExtractor, StorefrontVariants } from './storefront';
