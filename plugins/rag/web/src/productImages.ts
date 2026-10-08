import type * as cheerio from 'cheerio';
import { readPageEntity } from './pageEntity';
import { absoluteUrl, asArray, strip } from './storefront/shared';

/** One photo of the page's own product, with its colour when the page declares it. */
export interface ProductImage {
  url: string;
  color?: string;
}

/** Enough for a card gallery: a product with more photos keeps its first ones. */
export const MAX_PRODUCT_IMAGES = 8;

interface Candidate extends ProductImage {
  alt?: string;
}

/**
 * The photos of the page's OWN product, each with its colour only when the page says which one.
 *
 * WHY: a product stored one image, its `og:image`. MEASURED (2026-10-08): a Tiendanube product page
 * shows 4 to 6 photos of the product and a PrestaShop one 5, and the colour→image map meant to show
 * the photo of the colour asked for was empty on every stored page. Guessing a photo's colour from
 * its file name would need every site's naming convention; the page already says it, when it does.
 *
 * Where the photos come from, by how explicitly the page declares them:
 *  1. Declared variants: the own product's `hasVariant` / `model`, and the platform's product JSON
 *     (`declared`, read by the storefront adapter) — each photo with its variant's colour.
 *  2. The own product's `image`.
 *  3. Every `og:image` tag.
 *  4. The page's `<img>` whose alt text names the product. A "you may also like" carousel sits in the
 *     same markup and once gave a category page the price of its first product; its alt text names
 *     other products, so it stays out.
 *
 * Each source is a complete list on its own, and they name the same photo with different URLs (other
 * size, other slug), so only ONE is used. Declared variants with photos are the product's list as
 * they are, even with one photo: on PrestaShop the gallery renders each size of a photo as its own
 * `<img>`, so the gallery would count one photo three times. Otherwise the first source that lists
 * more than one photo, else the first that lists any.
 *
 * The cap keeps a photo of every colour: cutting a product's later colours would leave the colour
 * asked for with no photo to show.
 *
 * The colour of a photo no variant declares: one of the product's own colours named in its alt text,
 * else the product's only colour. Never a colour word the product does not list: descriptive alt
 * text ("Black granite facade") is why the variant extractor never reads alt text on its own.
 */
export function extractProductImages(
  $: cheerio.CheerioAPI,
  pageUrl: string | undefined,
  options: { colors: string[]; declared?: ProductImage[] },
): ProductImage[] {
  const page = readPageEntity($, pageUrl);
  if (page.pageType === 'collection') return [];
  const own = page.ownProduct;
  const declared = options.declared ?? [];
  if (!own && page.pageType !== 'detail' && declared.length === 0) return [];

  const variants = mergeSameUrl([...declared, ...variantImages(own, pageUrl)]);
  const picked = variants.length > 0 ? variants : firstListing([
    imageUrls(own?.image, pageUrl).map((url) => ({ url, ...(typeof own?.color === 'string' && own.color.trim() ? { color: own.color.trim() } : {}) })),
    $('meta[property="og:image"]').map((_, el) => absoluteUrl($(el).attr('content'), pageUrl)).get()
      .filter(isPhotoUrl).map((url) => ({ url })),
    galleryImages($, pageUrl, productNames(own, $)),
  ].map(mergeSameUrl));
  return capKeepingEveryColor(picked.map((image) => withColor(image, options.colors)), MAX_PRODUCT_IMAGES);
}

function firstListing(sources: Candidate[][]): Candidate[] {
  return sources.find((source) => source.length > 1) ?? sources.find((source) => source.length === 1) ?? [];
}

/** The first photos, plus the first one of every colour past the cap. Page order is kept. */
function capKeepingEveryColor(images: ProductImage[], max: number): ProductImage[] {
  if (images.length <= max) return images;
  const keep = new Set<number>();
  const colors = new Set<string>();
  images.forEach((image, index) => {
    const key = image.color ? strip(image.color) : undefined;
    if (key && !colors.has(key)) {
      colors.add(key);
      keep.add(index);
    }
  });
  for (let index = 0; index < images.length && keep.size < max; index++) keep.add(index);
  return images.filter((_, index) => keep.has(index)).slice(0, max);
}

function variantImages(own: Record<string, unknown> | undefined, pageUrl: string | undefined): Candidate[] {
  if (!own) return [];
  return [...asArray(own.hasVariant), ...asArray(own.model)].flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const variant = value as Record<string, unknown>;
    const color = typeof variant.color === 'string' && variant.color.trim() ? variant.color.trim() : undefined;
    return imageUrls(variant.image, pageUrl).map((url) => ({ url, ...(color ? { color } : {}) }));
  });
}

/** schema.org `image`: a URL, an `ImageObject` (`url` / `contentUrl`), or a list of either. */
function imageUrls(image: unknown, pageUrl: string | undefined): string[] {
  return asArray(image).flatMap((node) => {
    const raw = typeof node === 'string'
      ? node
      : node && typeof node === 'object'
        ? (node as Record<string, unknown>).url ?? (node as Record<string, unknown>).contentUrl
        : undefined;
    const url = typeof raw === 'string' ? absoluteUrl(raw, pageUrl) : undefined;
    return url && isPhotoUrl(url) ? [url] : [];
  });
}

/** The same photo declared twice keeps one entry; declared under two colours, it is neither. */
function mergeSameUrl(candidates: Candidate[]): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const seen = byUrl.get(candidate.url);
    if (!seen) {
      byUrl.set(candidate.url, { ...candidate });
    } else if (seen.color && candidate.color && strip(seen.color) !== strip(candidate.color)) {
      delete seen.color;
    }
  }
  return [...byUrl.values()];
}

/** How the page names its product, for matching alt text: two words at least, or it matches anything. */
function productNames(own: Record<string, unknown> | undefined, $: cheerio.CheerioAPI): string[] {
  const names = [own?.name, $('meta[property="og:title"]').attr('content')]
    .filter((name): name is string => typeof name === 'string')
    .map(words)
    .filter((name) => name.split(' ').length >= 2);
  return [...new Set(names)];
}

/**
 * The `<img>` that show the product: its alt text names it. A thumbnail strip and the main slider
 * show the same photo in two `<img>` that share a URL of their `srcset`, so `<img>` sharing a URL are
 * one photo, at its largest declared size.
 */
function galleryImages($: cheerio.CheerioAPI, pageUrl: string | undefined, names: string[]): Candidate[] {
  if (names.length === 0) return [];
  const photos: Array<{ urls: Set<string>; url: string; width: number; alt: string }> = [];
  $('body img').each((_, el) => {
    const alt = ($(el).attr('alt') ?? '').trim();
    const altWords = ` ${words(alt)} `;
    if (!names.some((name) => altWords.includes(` ${name} `))) return;
    const sources = imageSources($(el), pageUrl);
    if (sources.length === 0) return;
    const largest = sources.reduce((a, b) => (b.width > a.width ? b : a));
    const photo = photos.find((p) => sources.some((s) => p.urls.has(s.url)));
    if (!photo) {
      photos.push({ urls: new Set(sources.map((s) => s.url)), url: largest.url, width: largest.width, alt });
      return;
    }
    for (const source of sources) photo.urls.add(source.url);
    if (largest.width > photo.width) Object.assign(photo, { url: largest.url, width: largest.width });
  });
  return photos.map(({ url, alt }) => ({ url, alt }));
}

/**
 * The URLs an `<img>` declares for itself. Lazy loaders keep the real photo in `data-srcset` /
 * `data-src` and a placeholder in `src`, so `src` only counts when nothing else is declared.
 */
function imageSources(img: cheerio.Cheerio<any>, pageUrl: string | undefined): Array<{ url: string; width: number }> {
  const fromSrcset = ['data-srcset', 'srcset'].flatMap((attr) => parseSrcset(img.attr(attr), pageUrl));
  if (fromSrcset.length > 0) return fromSrcset;
  for (const attr of ['data-src', 'data-original', 'src']) {
    const url = absoluteUrl(img.attr(attr), pageUrl);
    if (url && isPhotoUrl(url)) return [{ url, width: 0 }];
  }
  return [];
}

function parseSrcset(srcset: string | undefined, pageUrl: string | undefined): Array<{ url: string; width: number }> {
  if (!srcset?.trim()) return [];
  return srcset.split(/,\s+/).flatMap((entry) => {
    const [raw, descriptor = ''] = entry.trim().split(/\s+/);
    const url = absoluteUrl(raw, pageUrl);
    if (!url || !isPhotoUrl(url)) return [];
    return [{ url, width: Number.parseFloat(descriptor) || 0 }];
  });
}

function isPhotoUrl(url: string | undefined): url is string {
  return Boolean(url) && !/^data:/i.test(url!) && !/\.svg(?:[?#]|$)/i.test(url!);
}

function withColor(image: Candidate, colors: string[]): ProductImage {
  const color = image.color ?? colorNamedIn(image.alt, colors) ?? (colors.length === 1 ? colors[0] : undefined);
  return color ? { url: image.url, color } : { url: image.url };
}

/** The one product colour the alt text names, as a whole word. Two named: neither. */
function colorNamedIn(alt: string | undefined, colors: string[]): string | undefined {
  if (!alt) return undefined;
  const altWords = ` ${words(alt)} `;
  const named = colors.filter((color) => {
    const colorWords = words(color);
    return colorWords.length > 0 && altWords.includes(` ${colorWords} `);
  });
  return named.length === 1 ? named[0] : undefined;
}

/** Lowercase, accent-free words separated by single spaces. */
function words(text: string): string {
  return strip(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
