/**
 * Page attribute extractor framework.
 *
 * A page extractor turns a crawled HTML page into structured attribute fields (+ searchable content
 * lines) for one domain/vertical: ecommerce variants, real-estate listings, etc. Extractors are
 * auto-detected per page — each reports a confidence via `detect()`, and only confident ones run —
 * so the right extractor self-selects with zero per-agent configuration ("it just works").
 *
 * `detect()` MUST be structural and conservative (bias to false negatives): a missing field is a
 * minor gap, but a hallucinated field (e.g. "expensas" on an architecture firm) breaks trust. When
 * in doubt, return 0.
 */
import type { CheerioAPI } from 'cheerio';

export interface PageExtractorContext {
  /** Full page HTML (not noise-stripped — variant/listing widgets often live in stripped forms). */
  html: string;
  /** Page URL, for resolving relative image URLs and URL-based signals. */
  url?: string;
  /** Lazily-shared cheerio handle over the full HTML (parsed once per page, reused by extractors). */
  $: CheerioAPI;
}

export interface PageExtractionResult {
  /** Fields merged into the document metadata. */
  metadata: Record<string, unknown>;
  /** Searchable lines appended to the indexed content (e.g. "Colores disponibles: Gris, Negro."). */
  contentLines: string[];
  /** True when this extractor found a price/value signal — feeds card eligibility. */
  hasPriceSignal?: boolean;
}

export interface PageAttributeExtractor {
  /** Stable id, surfaced for telemetry and override (disable/force) lists. */
  readonly id: string;
  /** Confidence (0 = skip) that this page belongs to this extractor's domain. Structural + conservative. */
  detect(ctx: PageExtractorContext): number;
  /** Extract attributes. Called only when detect() > 0 (or the extractor is force-enabled). */
  extract(ctx: PageExtractorContext): PageExtractionResult;
}
