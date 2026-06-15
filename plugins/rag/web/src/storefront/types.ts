import type { CheerioRoot } from './shared';

/** Variant data an extractor produces for one product page. */
export interface StorefrontVariants {
  colors: string[];
  sizes: string[];
  /**
   * Map of normalized color key (lowercase, accent-stripped) → absolute image URL, when the
   * storefront exposes per-color images statically. Used downstream to show the right-color card
   * image. Empty for platforms that resolve variant images via AJAX (e.g. PrestaShop).
   */
  colorImages?: Record<string, string>;
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
