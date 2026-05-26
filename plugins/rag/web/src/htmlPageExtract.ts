import * as cheerio from 'cheerio';
import { extractProductMetadata } from './productMetadata';

const DEFAULT_CONTENT_SELECTOR =
  'article, main, [role="main"], #content, #primary, #main, .content, .post-content, ' +
  '.entry-content, .elementor-location-content, .elementor-widget-theme-post-content, ' +
  '.wp-block-group, .site-content, .ast-single-post, .ast-page';

const DEFAULT_REMOVE_SELECTORS = [
  'script', 'style', 'nav', 'header', 'footer',
  '.sidebar', '.navigation', '.menu', '.comments',
  '[role="navigation"]', '[role="banner"]',
];

export interface HtmlPageExtractOptions {
  titleSelector?: string;
  contentSelector?: string;
  removeSelectors?: string[];
  defaultType?: string;
  typeFromUrl?: Record<string, string>;
  minExtractedContentLength?: number;
  metadata?: Record<string, unknown>;
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

  const titleSelector = options.titleSelector || 'h1, title';
  let title = $(titleSelector).first().text().trim();
  if (!title) {
    title = $('title').text().trim();
  }

  const content = extractBestContentText($, options);
  const minChars = options.minExtractedContentLength ?? 50;
  const indexable = Boolean(content && content.length >= minChars);

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

  const metadata: Record<string, unknown> = {
    type,
    ...(title ? { title } : {}),
    url,
    ...(imageUrl ? { imageUrl } : {}),
    ...(description ? { description } : {}),
    ...(productMeta.price != null ? { price: productMeta.price } : {}),
    ...(productMeta.currency ? { currency: productMeta.currency } : {}),
    ...(productMeta.availability ? { availability: productMeta.availability } : {}),
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
  let best = '';
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const t = cleanContent($(el).text().trim());
      if (t.length > best.length) best = t;
    });
  }
  const bodyText = cleanContent($('body').text().trim());
  if (bodyText.length > best.length) best = bodyText;
  return best;
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
