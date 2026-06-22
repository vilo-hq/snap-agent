import * as cheerio from 'cheerio';
import type {
  PageAttributeExtractor,
  PageExtractionResult,
  PageExtractorContext,
} from './types';

/**
 * Named registry of page attribute extractors.
 *
 * The SDK registers its built-in extractors (ecommerce variants) at module load; the host
 * application can register additional vertical/locale packs (e.g. a real-estate adapter) via
 * `registerPageExtractor`. Selection by `string` id (not closures) is what lets the host register
 * adapters that survive a serialized/queued crawl — the worker process resolves them from the
 * registry it populated at its own boot.
 */
const REGISTRY = new Map<string, PageAttributeExtractor>();

export function registerPageExtractor(extractor: PageAttributeExtractor): void {
  REGISTRY.set(extractor.id, extractor);
}

export function unregisterPageExtractor(id: string): void {
  REGISTRY.delete(id);
}

export function getRegisteredPageExtractors(): PageAttributeExtractor[] {
  return [...REGISTRY.values()];
}

export interface RunPageExtractorsOptions {
  /** Extractor ids to skip even if they self-detect (override: force-off). */
  disable?: string[];
  /** Extractor ids to run even if detect() returns 0 (override: force-on). */
  force?: string[];
}

export interface RunPageExtractorsResult extends PageExtractionResult {
  /** Ids of the extractors that matched and ran, highest-confidence first. */
  matched: string[];
}

/**
 * Run every registered extractor's `detect()` on the page; run `extract()` for the confident ones
 * (or force-enabled ones), highest-confidence first. Merges their metadata + content lines.
 *
 * On a metadata key collision the higher-confidence extractor wins (first writer keeps the key),
 * so the most relevant domain's fields take precedence. In practice strong, structural `detect()`
 * makes overlap rare — a product page and a listing page don't both confidently fire.
 */
export function runPageExtractors(
  input: { html: string; url?: string; $?: cheerio.CheerioAPI },
  options: RunPageExtractorsOptions = {},
): RunPageExtractorsResult {
  const disable = new Set(options.disable ?? []);
  const force = new Set(options.force ?? []);

  const extractors = getRegisteredPageExtractors().filter((x) => !disable.has(x.id));
  if (extractors.length === 0) {
    return { metadata: {}, contentLines: [], hasPriceSignal: false, matched: [] };
  }

  // Parse the full HTML once and share it across all extractors' detect()/extract().
  const ctx: PageExtractorContext = {
    html: input.html,
    url: input.url,
    $: input.$ ?? cheerio.load(input.html),
  };

  const scored = extractors
    .map((x) => ({ x, score: force.has(x.id) ? Math.max(x.detect(ctx), 1) : x.detect(ctx) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);

  const metadata: Record<string, unknown> = {};
  const contentLines: string[] = [];
  const matched: string[] = [];
  let hasPriceSignal = false;

  for (const { x } of scored) {
    const r = x.extract(ctx);
    matched.push(x.id);
    contentLines.push(...r.contentLines);
    if (r.hasPriceSignal) hasPriceSignal = true;
    for (const [k, v] of Object.entries(r.metadata)) {
      if (!(k in metadata)) metadata[k] = v;
    }
  }

  return { metadata, contentLines, hasPriceSignal, matched };
}
