import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { extractProductMetadata } from './productMetadata';
import { runPageExtractors } from './pageExtractors';
import { resolvePageDisplayMetadata } from './pageCardMetadata';

const DEFAULT_CONTENT_SELECTOR =
  'article, main, [role="main"], #content, #primary, #main, .content, .post-content, ' +
  '.entry-content, .elementor-location-content, .elementor-widget-theme-post-content, ' +
  '.wp-block-group, .site-content, .ast-single-post, .ast-page';

const DEFAULT_REMOVE_SELECTORS = [
  // Non-content elements (scripts, styles, embeds, interactive widgets)
  'script', 'style', 'noscript', 'svg', 'iframe', 'form', 'button',
  // Semantic page chrome
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="search"]', '[role="complementary"]', '[aria-hidden="true"]',
  // Class/id-based chrome on modern (esp. e-commerce) sites that don't use semantic tags.
  // `i` = case-insensitive substring match. Deliberately omits a blanket `[class*="header"]`,
  // which would also strip in-content section headers (e.g. product-card titles).
  '.sidebar', '.navigation', '.menu', '.comments',
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]', '[class*="gdpr" i]',
  '[class*="breadcrumb" i]', '[class*="newsletter" i]',
  '[class*="related" i]', '[class*="recommend" i]', '[class*="upsell" i]',
  '[class*="cross-sell" i]', '[class*="crosssell" i]',
  '[class*="carousel" i]', '[class*="slider" i]',
  '[class*="navbar" i]', '[class*="mega-menu" i]',
  '[class*="site-footer" i]', '[class*="page-footer" i]', '[id*="footer" i]',
];

/** Link-dense blocks (nav remnants, footers, "related products" grids) are boilerplate, not prose. */
const LINK_DENSITY_THRESHOLD = 0.5;
const LINK_DENSITY_MIN_LINKS = 3;
const LINK_DENSITY_MIN_TEXT = 40;

export interface HtmlPageExtractOptions {
  titleSelector?: string;
  contentSelector?: string;
  removeSelectors?: string[];
  defaultType?: string;
  typeFromUrl?: Record<string, string>;
  minExtractedContentLength?: number;
  metadata?: Record<string, unknown>;
  /**
   * Extract variant colors/sizes (default true) into metadata and append a "Colores/Tallas" line to
   * the indexed content so color/size become searchable. Set false for non-product sites.
   */
  extractVariantMetadata?: boolean;
}

export interface HtmlPageExtractResult {
  id: string;
  metadata: Record<string, unknown>;
  content: string;
  /** True when content meets minExtractedContentLength (default 50). */
  indexable: boolean;
  contentPreview: string;
}

export function urlToDocumentId(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/**
 * Document identity for the provided-HTML path.
 *
 * `urlToDocumentId` truncates to 100 characters and does not carry the source, so two long URLs
 * from the same site — or the same URL under two sources of the same agent — collide. This one does
 * not collide, and keeps the source up front so a row stays readable in the database.
 *
 * It does not replace `urlToDocumentId`: changing that one would orphan everything already indexed.
 */
export function sourceScopedDocumentId(sourceId: string, url: string): string {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 40);
  return `${sourceId}:${digest}`;
}

export function cleanContent(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .replace(/\t/g, ' ')
    .trim();
}

export function bodyTextLengthHint(html: string, options: HtmlPageExtractOptions = {}): number {
  const $ = cheerio.load(html);
  stripNoiseFromDom($, options);
  return cleanContent($('body').text().trim()).length;
}

/**
 * Extract full page metadata + main content the same way web-rag does on HTML ingest.
 * Unlike ingest, always returns metadata even when content is too short to index.
 */
export function extractPageFromHtml(
  url: string,
  html: string,
  options: HtmlPageExtractOptions = {},
): HtmlPageExtractResult {
  const $ = cheerio.load(html);
  stripNoiseFromDom($, options);

  const h1Title = $('h1').first().text().trim();
  const docTitle = $('title').text().trim();
  let title = '';
  if (options.titleSelector) {
    title = $(options.titleSelector).first().text().trim();
  } else {
    title = docTitle || h1Title;
  }
  if (!title) {
    title = h1Title || docTitle;
  }

  const baseContent = extractBestContentText($, options);
  // Attribute extraction runs over the FULL html (not the noise-stripped DOM), since variant/listing
  // widgets often live in stripped <form>s. Registered extractors auto-detect per page; the legacy
  // `extractVariantMetadata: false` toggle maps to disabling the ecommerce-variants extractor.
  const extracted = runPageExtractors(
    { html, url },
    options.extractVariantMetadata === false ? { disable: ['ecommerce-variants'] } : {},
  );
  const productMeta = extractProductMetadata(html);
  const extraLines = [...extracted.contentLines].filter(Boolean);
  const content =
    extraLines.length > 0 ? `${baseContent}\n\n${extraLines.join('\n\n')}` : baseContent;
  const minChars = options.minExtractedContentLength ?? 50;
  const indexable = Boolean(baseContent && baseContent.length >= minChars);

  const image =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="product:image"]').attr('content') ||
    $('[itemtype*="schema.org/Product"] img, .product img, .product-image img, #product-image img')
      .first().attr('src') ||
    extractHeroImage($, url) ||
    undefined;

  let imageUrl: string | undefined;
  if (image) {
    try {
      imageUrl = new URL(image, url).href;
    } catch {
      imageUrl = image;
    }
  }

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    undefined;

  // `type` is ONLY what the caller configured. The plugin no longer infers a page role: it emits
  // `observations` and whoever knows the vertical decides. With neither `defaultType` nor
  // `typeFromUrl` the field is not written — one constant value on every page carries no information.
  let type: string | undefined = options.defaultType;
  if (options.typeFromUrl) {
    for (const [pattern, typeName] of Object.entries(options.typeFromUrl)) {
      if (url.includes(pattern)) {
        type = typeName;
        break;
      }
    }
  }

  // Top-level price/currency: basics (productMeta) win; otherwise an extractor's price (e.g. a
  // real-estate listing price surfaced into extracted.metadata).
  const extractedPrice =
    typeof extracted.metadata.price === 'number' ? extracted.metadata.price : undefined;
  const extractedCurrency =
    typeof extracted.metadata.currency === 'string' ? extracted.metadata.currency : undefined;
  const price = productMeta.price ?? extractedPrice;
  const currency = productMeta.currency ?? extractedCurrency;

  const display = resolvePageDisplayMetadata({
    url,
    title,
    headingTitle: h1Title || undefined,
    description,
    imageUrl,
    html,
    hasPriceSignal: productMeta.price != null || extracted.hasPriceSignal,
  });

  const metadata: Record<string, unknown> = {
    // `cardEligible` / `cardPriority` no longer come from here: what deserves to be a card depends
    // on the caller's entity model, not on the shape of the page. What does travel is the evidence.
    ...(type ? { type } : {}),
    observations: display.observations,
    ...(title ? { title } : {}),
    ...(display.displayTitle ? { displayTitle: display.displayTitle } : {}),
    url,
    ...(imageUrl ? { imageUrl } : {}),
    ...(display.displayImageUrl ? { displayImageUrl: display.displayImageUrl } : {}),
    ...(description ? { description } : {}),
    ...(display.displayDescription ? { displayDescription: display.displayDescription } : {}),
    ...(productMeta.availability ? { availability: productMeta.availability } : {}),
    ...extracted.metadata,
    // Computed price/currency last so basics (productMeta) take precedence over an extractor's.
    ...(price != null ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...options.metadata,
  };

  const previewLen = 400;
  const contentPreview =
    content.length > previewLen ? `${content.slice(0, previewLen)}…` : content;

  return {
    id: urlToDocumentId(url),
    metadata,
    content,
    indexable,
    contentPreview,
  };
}

function stripNoiseFromDom($: cheerio.CheerioAPI, options: HtmlPageExtractOptions): void {
  const removeSelectors = options.removeSelectors ?? DEFAULT_REMOVE_SELECTORS;
  removeSelectors.forEach(selector => $(selector).remove());
}

function extractBestContentText($: cheerio.CheerioAPI, options: HtmlPageExtractOptions): string {
  const contentSelector = options.contentSelector || DEFAULT_CONTENT_SELECTOR;
  const selectors = contentSelector.split(',').map(s => s.trim()).filter(Boolean);

  // Pick the largest matching container by text length — and keep the element, so we can prune
  // boilerplate inside it before serializing.
  let bestEl: cheerio.Cheerio<any> | null = null;
  let bestLen = 0;
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const node = $(el);
      const t = cleanContent(node.text()).length;
      if (t > bestLen) {
        bestLen = t;
        bestEl = node;
      }
    });
  }

  // Only fall back to <body> when NO content container matched. Previously the body was used
  // whenever it had more text than the best match — which is almost always true on real sites,
  // so the whole header/footer/nav got ingested and contentSelector was effectively ignored.
  const scope: cheerio.Cheerio<any> = bestEl ?? $('body');

  pruneLinkDenseBlocks($, scope);

  return cleanContent(scope.text().trim());
}

/**
 * Remove descendant blocks that are mostly links (nav menus, footers, "related products" grids).
 * Generic boilerplate removal that needs no per-site selectors: real prose has low link density.
 * Never removes `scope` itself, so a pure link-grid page simply ends up empty (→ not indexable).
 */
function pruneLinkDenseBlocks($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): void {
  const toRemove: any[] = [];
  scope.find('ul, ol, nav, header, footer, aside, section, div').each((_, el) => {
    const node = $(el);
    const links = node.find('a');
    if (links.length < LINK_DENSITY_MIN_LINKS) return;
    const total = cleanContent(node.text()).length;
    if (total < LINK_DENSITY_MIN_TEXT) return;
    let linkLen = 0;
    links.each((_, a) => {
      linkLen += cleanContent($(a).text()).length;
    });
    if (linkLen / Math.max(total, 1) > LINK_DENSITY_THRESHOLD) toRemove.push(el);
  });
  toRemove.forEach((el) => $(el).remove());
}

function extractHeroImage($: cheerio.CheerioAPI, pageUrl: string): string | undefined {
  const containers = $('main, article, [role="main"], #content, .content');
  const scope = containers.length > 0 ? containers : $('body');

  let best: string | undefined;
  scope.find('img[src]').each((_, el) => {
    if (best) return false;
    const src = $(el).attr('src') || '';
    const alt = ($(el).attr('alt') || '').toLowerCase();
    const width = parseInt($(el).attr('width') || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);

    if ((width > 0 && width < 80) || (height > 0 && height < 80)) return;
    if (/logo|icon|avatar|favicon|badge|spinner|loading/i.test(src + ' ' + alt)) return;
    if (src.startsWith('data:') || src.endsWith('.svg')) return;

    if (src.includes('/_next/image')) {
      try {
        const nextUrl = new URL(src, pageUrl);
        const realUrl = nextUrl.searchParams.get('url');
        if (realUrl) {
          best = realUrl.startsWith('http') ? realUrl : new URL(realUrl, pageUrl).href;
          return false;
        }
      } catch { /* fall through */ }
    }

    best = src;
    return false;
  });

  return best;
}
