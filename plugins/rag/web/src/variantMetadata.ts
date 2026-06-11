import * as cheerio from 'cheerio';

/**
 * General variant (color / size) extraction.
 *
 * E-commerce sites expose variants in wildly different shapes, so this is a layered cascade —
 * highest-precision source first, falling through to lexicon-driven heuristics so we catch the long
 * tail (PrestaShop, bespoke themes) that lack structured data:
 *
 *   1. schema.org JSON-LD Product (`color`, `size`, `additionalProperty`, `hasVariant`)
 *   2. embedded JSON state (`"group":"Color"` / `"color":"…"` blobs — PrestaShop, Shopify, Woo)
 *   3. microdata / OpenGraph (`itemprop="color"`, `product:color`)
 *   4. swatch / <select> / alt-text heuristics, filtered by a color lexicon
 *
 * Structured sources (1–3, and labeled widgets) are trusted as-is; unlabeled heuristic text (alt,
 * generic swatches) must match the color lexicon to avoid noise. Best-effort, not ground truth.
 */
export interface VariantMetadata {
  colors: string[];
  sizes: string[];
}

const MAX_VALUES = 24;

/** Color stems (es/en/pt/fr/it/de common). Used to validate unlabeled heuristic text. */
const COLOR_STEMS = [
  'verd', 'azul', 'roj', 'negr', 'blanc', 'gris', 'amarill', 'naranj', 'morad', 'violet', 'lila',
  'ros', 'marron', 'beige', 'crud', 'crema', 'celest', 'turques', 'dorad', 'plate', 'plata',
  'granate', 'burdeos', 'caqui', 'coral', 'fucsia', 'menta', 'salmon', 'camel', 'mostaza', 'teja',
  'vino', 'nude', 'topo', 'arena', 'oliva', 'marino', 'antracita', 'tostado',
  'green', 'blue', 'red', 'black', 'white', 'gray', 'grey', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'beige', 'teal', 'navy', 'gold', 'silver', 'maroon', 'khaki', 'cream', 'ivory', 'tan',
  'preto', 'branco', 'vermelh', 'amarel', 'cinza', 'verde', 'rouge', 'noir', 'blanc', 'vert',
  'bleu', 'jaune', 'rosso', 'nero', 'bianco', 'verde', 'schwarz', 'weiss', 'blau', 'rot', 'grun',
];

const SIZE_RE = /^(?:x{0,3}[sl]|m|x{0,3}large|x{0,3}small|medium|talla\s*\w+|size\s*\w+|[úÚu]nica|one\s*size|t\.?\s*\d{1,3}|\d{1,3})$/i;

function strip(text: string): string {
  return (text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function isColorLike(value: string): boolean {
  const head = strip(value).split(/[\s/,-]+/)[0] ?? '';
  return COLOR_STEMS.some((stem) => head.startsWith(stem));
}

function isSizeLike(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 12) return false;
  return SIZE_RE.test(strip(v)) || SIZE_RE.test(v);
}

/** Case/accent-insensitive dedupe that keeps the first original spelling, capped. */
function collect(values: Iterable<string>, max = MAX_VALUES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!v || v.length > 40) continue;
    const key = strip(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

export function extractVariants(html: string): VariantMetadata {
  const $ = cheerio.load(html);
  const colors: string[] = [];
  const sizes: string[] = [];

  collectFromJsonLd($, colors, sizes);
  collectFromMicrodataAndOg($, colors);
  collectFromEmbeddedJson(html, colors, sizes);
  collectFromWidgets($, colors, sizes);

  return { colors: collect(colors), sizes: collect(sizes) };
}

// ── Layer 1: schema.org JSON-LD ────────────────────────────────────────────────
function collectFromJsonLd($: cheerio.CheerioAPI, colors: string[], sizes: string[]): void {
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const node of jsonNodes(parsed)) {
      pushVal(colors, node.color);
      pushVal(sizes, node.size);
      // additionalProperty: [{ name: 'Color', value: 'Gris' }, …]
      for (const prop of asArray(node.additionalProperty)) {
        if (!prop || typeof prop !== 'object') continue;
        const p = prop as Record<string, unknown>;
        const name = strip(String(p.name ?? ''));
        if (/colou?r/.test(name)) pushVal(colors, p.value);
        else if (/size|talla|tama/.test(name)) pushVal(sizes, p.value);
      }
      // ProductGroup variants
      for (const v of [...asArray(node.hasVariant), ...asArray(node.model)]) {
        if (!v || typeof v !== 'object') continue;
        const vv = v as Record<string, unknown>;
        pushVal(colors, vv.color);
        pushVal(sizes, vv.size);
      }
    }
  });
}

// ── Layer 2: microdata + OpenGraph ─────────────────────────────────────────────
function collectFromMicrodataAndOg($: cheerio.CheerioAPI, colors: string[]): void {
  $('[itemprop="color"]').each((_, el) => {
    pushVal(colors, $(el).attr('content') || $(el).text());
  });
  const og = $('meta[property="product:color"]').attr('content');
  if (og) pushVal(colors, og);
}

// ── Layer 3: embedded JSON state (PrestaShop / Shopify / Woo) ───────────────────
function collectFromEmbeddedJson(html: string, colors: string[], sizes: string[]): void {
  // PrestaShop-style: {"name":"Gris","group":"Color"} (also "Colour"/"Couleur"/"Tonalidad").
  const grouped = /"name"\s*:\s*"([^"]{1,40})"\s*,\s*"group"\s*:\s*"([^"]{1,40})"/gi;
  let m: RegExpExecArray | null;
  while ((m = grouped.exec(html)) !== null) {
    const value = decodeEntities(m[1]);
    const group = strip(m[2]);
    if (/colou?r|couleur|cor|farbe/.test(group)) pushVal(colors, value);
    else if (/size|talla|tama|taille|taglia|gr[oö]/.test(group)) pushVal(sizes, value);
  }
  // Generic "color":"X" / "colour":"X"
  const direct = /"colou?r"\s*:\s*"([^"]{1,40})"/gi;
  while ((m = direct.exec(html)) !== null) {
    const value = decodeEntities(m[1]);
    if (isColorLike(value)) pushVal(colors, value);
  }
}

// ── Layer 4: swatch / <select> / alt heuristics (strictly lexicon-filtered) ─────
// Heuristic text is messy on real pages (concatenated sibling labels, size swatches in color
// scopes, chat widgets), so every color candidate here must pass the color lexicon, and element
// values use OWN text only (no descendants) to avoid merging sibling labels.
function collectFromWidgets($: cheerio.CheerioAPI, colors: string[], sizes: string[]): void {
  const pushColorIf = (raw: unknown) => {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (s && s.length <= 30 && isColorLike(s)) pushVal(colors, s);
  };
  const ownText = (el: any) => $(el).clone().children().remove().end().text();

  // Leaf swatch labels (own text only) — route to size or color by what the label looks like
  // (some sites use the same widget shape for both groups, with no "size" class to key off).
  $('.label-color, .color-texto, .label-size, [class*="swatch" i] .sr-only, [class*="variant" i] .sr-only, [class*="color" i] .sr-only, [data-color] .sr-only')
    .each((_, el) => {
      const t = ownText(el);
      if (isSizeLike(t)) pushVal(sizes, t);
      else pushColorIf(t);
    });

  // Swatch attributes → token-extract color words.
  $('[class*="color" i][aria-label], [class*="swatch" i][aria-label], [data-color], [data-colour], [class*="color" i][title]')
    .each((_, el) => {
      const v = $(el).attr('aria-label') || $(el).attr('title') || $(el).attr('data-color') || $(el).attr('data-colour') || '';
      for (const tok of v.split(/[\s,/-]+/)) pushColorIf(tok);
    });

  // <select> color/size pickers.
  $('select').each((_, sel) => {
    const ctx = strip(
      `${$(sel).attr('name') ?? ''} ${$(sel).attr('id') ?? ''} ${$(sel).attr('aria-label') ?? ''}`,
    );
    const isColor = /colou?r|couleur/.test(ctx);
    const isSize = /size|talla|tama|taille|taglia/.test(ctx);
    if (!isColor && !isSize) return;
    $(sel)
      .find('option')
      .each((__, opt) => {
        const v = $(opt).text().trim();
        if (!v || /^(?:elige|select|choose|--)/i.test(strip(v))) return;
        if (isColor) pushColorIf(v);
        else if (isSizeLike(v)) pushVal(sizes, v);
      });
  });

  // Image alt/title often encodes the visible variant color ("… gris vista frontal").
  $('img[alt], img[title]').each((_, el) => {
    const alt = $(el).attr('alt') || $(el).attr('title') || '';
    for (const token of alt.split(/[\s,/-]+/)) {
      if (token.length >= 3) pushColorIf(token);
    }
  });

  // Sizes also live in plain swatch buttons (S/M/L/XL).
  $('[class*="size" i] *, [class*="talla" i] *, [data-size]').each((_, el) => {
    const v = ($(el).attr('data-size') || ownText(el)).trim();
    if (isSizeLike(v)) pushVal(sizes, v);
  });
}

// ── helpers ────────────────────────────────────────────────────────────────────
function pushVal(into: string[], value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) pushVal(into, v);
    return;
  }
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s) into.push(s);
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonNodes(data: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    nodes.push(obj);
    if (obj['@graph']) visit(obj['@graph']);
    if (obj['hasVariant']) visit(obj['hasVariant']);
  };
  visit(data);
  return nodes;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u00([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
