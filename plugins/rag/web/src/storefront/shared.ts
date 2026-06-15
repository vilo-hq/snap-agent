import * as cheerio from 'cheerio';

/**
 * Shared lexicons + helpers for storefront variant extraction.
 *
 * Color/size detection is multilingual and noise-tolerant: real storefronts mix marketing names
 * ("Gris Vigoré Claro"), sibling-label concatenation, and size swatches inside color scopes, so
 * unlabeled heuristic text is validated against a color/size lexicon before it is trusted.
 */

export const MAX_VALUES = 24;

/** Color stems (es/en/pt/fr/it/de common). Used to validate unlabeled heuristic text. */
export const COLOR_STEMS = [
  'verd', 'azul', 'roj', 'negr', 'blanc', 'gris', 'amarill', 'naranj', 'morad', 'violet', 'lila',
  'ros', 'marron', 'beige', 'crud', 'crema', 'celest', 'turques', 'dorad', 'plate', 'plata',
  'granate', 'burdeos', 'caqui', 'coral', 'fucsia', 'menta', 'salmon', 'camel', 'mostaza', 'teja',
  'vino', 'nude', 'topo', 'arena', 'oliva', 'marino', 'antracita', 'tostado',
  'green', 'blue', 'red', 'black', 'white', 'gray', 'grey', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'beige', 'teal', 'navy', 'gold', 'silver', 'maroon', 'khaki', 'cream', 'ivory', 'tan',
  'preto', 'branco', 'vermelh', 'amarel', 'cinza', 'verde', 'rouge', 'noir', 'blanc', 'vert',
  'bleu', 'jaune', 'rosso', 'nero', 'bianco', 'verde', 'schwarz', 'weiss', 'blau', 'rot', 'grun',
];

export const SIZE_RE = /^(?:x{0,3}[sl]|m|x{0,3}large|x{0,3}small|medium|talla\s*\w+|size\s*\w+|[úÚu]nica|one\s*size|t\.?\s*\d{1,3}|\d{1,3})$/i;

/** Regexes that match a color/size group LABEL (multilingual). */
export const COLOR_GROUP_RE = /colou?r|couleur|cor|farbe|tonalidad|gama/i;
export const SIZE_GROUP_RE = /size|talla|tama|taille|taglia|gr[oö]ße|gr[oö]sse/i;

export function strip(text: string): string {
  return (text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function isColorLike(value: string): boolean {
  const head = strip(value).split(/[\s/,-]+/)[0] ?? '';
  return COLOR_STEMS.some((stem) => head.startsWith(stem));
}

export function isSizeLike(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 12) return false;
  return SIZE_RE.test(strip(v)) || SIZE_RE.test(v);
}

/** Normalized key for a color value (case/accent-insensitive), used to key colorImages + dedupe. */
export function colorKey(value: string): string {
  return strip(value).replace(/\s+/g, ' ');
}

/** Case/accent-insensitive dedupe that keeps the first original spelling, capped. */
export function collect(values: Iterable<string>, max = MAX_VALUES): string[] {
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

export function pushVal(into: string[], value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) pushVal(into, v);
    return;
  }
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s) into.push(s);
}

export function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Walk a parsed JSON-LD tree, yielding every object node (following @graph / hasVariant). */
export function jsonNodes(data: unknown): Record<string, unknown>[] {
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

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u00([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Resolve a possibly-relative/protocol-relative image URL against the page URL. */
export function absoluteUrl(src: string | undefined, pageUrl?: string): string | undefined {
  if (!src) return undefined;
  const s = src.trim();
  if (!s) return undefined;
  if (s.startsWith('//')) return `https:${s}`;
  if (!pageUrl) return s;
  try {
    return new URL(s, pageUrl).href;
  } catch {
    return s;
  }
}

export type CheerioRoot = cheerio.CheerioAPI;
export type CheerioScope = cheerio.Cheerio<any>;
