import * as cheerio from 'cheerio';
import { extractProductMetadata } from './productMetadata';
import { extractVariants, type VariantMetadata } from './variantMetadata';
import { resolvePageCardMetadata } from './pageCardMetadata';

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

/** Append the available colors/sizes to indexed content so they're searchable (bilingual label). */
function formatVariantLine(v: VariantMetadata): string {
  const parts: string[] = [];
  if (v.colors.length > 0) parts.push(`Colores disponibles / available colors: ${v.colors.join(', ')}.`);
  if (v.sizes.length > 0) parts.push(`Tallas disponibles / available sizes: ${v.sizes.join(', ')}.`);
  return parts.join(' ');
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
  // Variants are read from the FULL html (not the noise-stripped DOM), since swatch widgets are
  // often inside stripped <form>s. Appending them keeps color/size searchable.
  const variants: VariantMetadata =
    options.extractVariantMetadata === false ? { colors: [], sizes: [] } : extractVariants(html);
  const variantLine = formatVariantLine(variants);
  const content = variantLine ? `${baseContent}\n\n${variantLine}` : baseContent;
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

  let type = options.defaultType || 'page';
  if (options.typeFromUrl) {
    for (const [pattern, typeName] of Object.entries(options.typeFromUrl)) {
      if (url.includes(pattern)) {
        type = typeName;
        break;
      }
    }
  }

  const productMeta = extractProductMetadata(html);

  const cardMeta = resolvePageCardMetadata({
    url,
    title,
    headingTitle: h1Title || undefined,
    description,
    imageUrl,
    html,
    type,
    hasProductPrice: productMeta.price != null,
  });

  const metadata: Record<string, unknown> = {
    type: cardMeta.type,
    cardEligible: cardMeta.cardEligible,
    cardPriority: cardMeta.cardPriority,
    ...(title ? { title } : {}),
    ...(cardMeta.displayTitle ? { displayTitle: cardMeta.displayTitle } : {}),
    url,
    ...(imageUrl ? { imageUrl } : {}),
    ...(cardMeta.displayImageUrl ? { displayImageUrl: cardMeta.displayImageUrl } : {}),
    ...(description ? { description } : {}),
    ...(cardMeta.displayDescription ? { displayDescription: cardMeta.displayDescription } : {}),
    ...(productMeta.price != null ? { price: productMeta.price } : {}),
    ...(productMeta.currency ? { currency: productMeta.currency } : {}),
    ...(productMeta.availability ? { availability: productMeta.availability } : {}),
    ...(variants.colors.length > 0 ? { colors: variants.colors } : {}),
    ...(variants.sizes.length > 0 ? { sizes: variants.sizes } : {}),
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
