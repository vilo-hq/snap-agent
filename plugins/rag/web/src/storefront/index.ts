import * as cheerio from 'cheerio';
import type { StorefrontExtractor, StorefrontVariants } from './types';
import { collect } from './shared';
import { extractStructured } from './structured';
import { extractHeuristics } from './heuristics';
import { prestashopExtractor } from './prestashop';
import { shopifyExtractor } from './shopify';

export type { StorefrontExtractor, StorefrontVariants } from './types';

/** Result of variant extraction for one product page. */
export interface VariantMetadata {
  colors: string[];
  sizes: string[];
  /** Normalized color key → absolute image URL, when the platform exposes per-color images. */
  colorImages?: Record<string, string>;
  /** Which extractor produced the structured result ('prestashop' | 'shopify' | 'generic'). */
  platform?: string;
}

/**
 * Platform adapters, tried by detection confidence. The schema.org/structured layer (see
 * `extractStructured`) is NOT in this list — it always runs as the universal baseline, and the
 * generic DOM heuristic runs whole-page only when no adapter matches.
 */
const ADAPTERS: StorefrontExtractor[] = [prestashopExtractor, shopifyExtractor];

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

  const base = extractStructured($, html, pageUrl);

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
  const colorImages = { ...base.colorImages, ...dom.colorImages };

  const result: VariantMetadata = { colors, sizes };
  if (Object.keys(colorImages).length > 0) result.colorImages = colorImages;
  // 'generic' when the structured/heuristic baseline produced something but no platform matched.
  if (platformName) result.platform = platformName;
  else if (colors.length > 0 || sizes.length > 0) result.platform = 'generic';

  return result;
}
