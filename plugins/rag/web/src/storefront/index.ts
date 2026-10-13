import * as cheerio from 'cheerio';
import type { ProductVariant, StorefrontExtractor, StorefrontVariants, VariantRole } from './types';
import { collect } from './shared';
import { extractStructured } from './structured';
import { extractHeuristics } from './heuristics';
import { prestashopExtractor } from './prestashop';
import { shopifyExtractor } from './shopify';
import { tiendanubeExtractor } from './tiendanube';
import { extractProductImages, type ProductImage } from '../productImages';

export type { ProductVariant, StorefrontExtractor, StorefrontVariants, VariantRole } from './types';

/** Result of variant extraction for one product page. */
export interface VariantMetadata {
  colors: string[];
  sizes: string[];
  /** The page's own product photos, each with its colour when the page declares it. */
  images?: ProductImage[];
  /** Which extractor produced the structured result ('prestashop' | 'shopify' | 'tiendanube' | 'generic'). */
  platform?: string;
  /** Every visible combination with its availability, when the platform declares it. */
  variants?: ProductVariant[];
  /** Role of each `variants[].options` key that has one. */
  variantRoles?: Record<string, VariantRole>;
  /** `variants` was cut at the cap. */
  variantsTruncated?: true;
}

/**
 * Platform adapters, tried by detection confidence. The schema.org/structured layer (see
 * `extractStructured`) is NOT in this list — it always runs as the universal baseline, and the
 * generic DOM heuristic runs whole-page only when no adapter matches.
 */
const ADAPTERS: StorefrontExtractor[] = [prestashopExtractor, shopifyExtractor, tiendanubeExtractor];

/**
 * Auto-detected storefront variant extraction.
 *
 * Pipeline:
 *   1. structured baseline (JSON-LD / microdata / embedded JSON) — always, low-noise, whole-page.
 *   2. the highest-confidence platform adapter, if any — scoped to the main product (no bleed).
 *   3. if NO adapter matches, the generic DOM heuristic, whole-page (long-tail bespoke shops).
 * Results are merged (platform/heuristic + baseline), deduped and capped.
 */
export function extractVariants(html: string, pageUrl?: string): VariantMetadata {
  const $ = cheerio.load(html);

  const base = extractStructured($, html);

  let platform: StorefrontExtractor | null = null;
  let bestScore = 0;
  for (const adapter of ADAPTERS) {
    const score = adapter.detect(html, $);
    if (score > bestScore) {
      bestScore = score;
      platform = adapter;
    }
  }

  let dom: StorefrontVariants;
  let platformName: string | undefined;
  if (platform) {
    dom = platform.extract(html, $, pageUrl);
    platformName = platform.platform;
  } else {
    // No recognized platform → fall back to whole-page heuristics for bespoke storefronts.
    dom = extractHeuristics($, $.root());
  }

  const colors = collect([...base.colors, ...dom.colors]);
  const sizes = collect([...base.sizes, ...dom.sizes]);
  const images = extractProductImages($, pageUrl, { colors, declared: dom.images });

  const result: VariantMetadata = { colors, sizes };
  if (images.length > 0) result.images = images;
  if (dom.variants && dom.variants.length > 0) {
    result.variants = dom.variants;
    result.variantRoles = dom.variantRoles ?? {};
    if (dom.variantsTruncated) result.variantsTruncated = true;
  }
  // 'generic' when the structured/heuristic baseline produced something but no platform matched.
  if (platformName) result.platform = platformName;
  else if (colors.length > 0 || sizes.length > 0) result.platform = 'generic';

  return result;
}
