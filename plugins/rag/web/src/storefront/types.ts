import type { CheerioRoot } from './shared';
import type { ProductImage } from '../productImages';

/** Variant data an extractor produces for one product page. */
export interface StorefrontVariants {
  colors: string[];
  sizes: string[];
  /**
   * Per-variant photos the platform declares outside schema.org (Shopify's product JSON), each with
   * its variant's colour. Absent for platforms that resolve variant images via AJAX (PrestaShop).
   */
  images?: ProductImage[];
  /** Every visible combination with its availability (platforms that declare it: Tiendanube). */
  variants?: ProductVariant[];
  /** Role of each `variants[].options` key that has one. */
  variantRoles?: Record<string, VariantRole>;
  /** More variants than the cap: `variants` is cut, so it cannot say a size is missing. */
  variantsTruncated?: true;
}

export type VariantRole = 'color' | 'size';

/** One purchasable combination of the product's options. */
export interface ProductVariant {
  /** Key = the group's label as the store declares it («Talle», «Color», «Medida»). */
  options: Record<string, string>;
  available: boolean;
  /** Only when the price differs between variants. */
  price?: number;
  /** «Consultar precio»: no price, not bought online. */
  contact?: true;
}

/**
 * A storefront platform adapter. Adapters are auto-detected (never user-selected) and only run when
 * `detect()` is confident; the schema.org/structured baseline always runs underneath as a fallback.
 */
export interface StorefrontExtractor {
  /** Stable platform id, surfaced in metadata for telemetry/debugging (e.g. 'prestashop'). */
  readonly platform: string;
  /** Confidence this page is this platform: 0 = not detected, higher = stronger. */
  detect(html: string, $: CheerioRoot): number;
  /** Extract variants. Called only when `detect()` > 0. `pageUrl` resolves relative image URLs. */
  extract(html: string, $: CheerioRoot, pageUrl?: string): StorefrontVariants;
}
