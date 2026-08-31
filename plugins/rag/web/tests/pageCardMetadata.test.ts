import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JUNK_TITLE_PATTERNS,
  DEFAULT_JUNK_URL_PATTERNS,
  STOREFRONT_URL_PATTERNS,
  extractPathSegments,
  extractSchemaTypes,
  matchesAny,
  normalizeDisplayTitle,
  resolvePageDisplayMetadata,
} from '../src/pageCardMetadata';

describe('normalizeDisplayTitle', () => {
  it('normalizes SEO title suffixes', () => {
    expect(normalizeDisplayTitle('Habitaciones | Eco Hotel Punta Brava')).toBe('Habitaciones');
    expect(normalizeDisplayTitle('Riverside Medical Center | Example Studio')).toBe(
      'Riverside Medical Center',
    );
  });

  /** The minimum indices exist so a short leading segment is not eaten by an early separator. */
  it('leaves a short leading segment alone', () => {
    expect(normalizeDisplayTitle('Casa | Muy Larga Marca')).toBe('Casa | Muy Larga Marca');
  });
});

describe('observations — the page speaks, the plugin does not interpret', () => {
  /**
   * The case that drove the change: the site declares `Person`. `SCHEMA_TYPE_MAP` used to flatten
   * that to `detail`, and the host had to rediscover the class from the URL with duplicated regexes.
   */
  it('reports the declared @type verbatim instead of flattening it', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Person","name":"Oscar Cobb"}
    </script></head><body></body></html>`;
    expect(extractSchemaTypes(html)).toEqual(['person']);
  });

  it('walks @graph and keeps every declared type', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":["NewsArticle","CreativeWork"]}]}
    </script></head><body></body></html>`;
    expect(extractSchemaTypes(html).sort()).toEqual(['creativework', 'newsarticle', 'webpage']);
  });

  it('flags offers without a readable @type', () => {
    const html = `<html><head><script type="application/ld+json">
      {"name":"Widget","offers":{"price":"10"}}
    </script></head><body></body></html>`;
    expect(extractSchemaTypes(html)).toContain('offer');
  });

  it('survives a broken JSON-LD block without losing the good ones', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ roto </script>
      <script type="application/ld+json">{"@type":"Product"}</script>
    </head><body></body></html>`;
    expect(extractSchemaTypes(html)).toEqual(['product']);
  });

  it('exposes path segments so the caller can key on the collection slug', () => {
    expect(extractPathSegments('https://example.com/our-work/projects/acme-tower')).toEqual([
      'our-work',
      'projects',
      'acme-tower',
    ]);
    expect(extractPathSegments('no soy una url')).toEqual([]);
  });

  it('emits presence signals, not verdicts', () => {
    const html = `<html><head>
      <meta property="og:type" content="article" />
      <meta property="article:published_time" content="2026-01-01" />
      <meta name="author" content="Jane" />
    </head><body><h1>Titulo</h1></body></html>`;
    const r = resolvePageDisplayMetadata({
      url: 'https://example.com/news/algo',
      headingTitle: 'Titulo',
      html,
      hasPriceSignal: false,
    });
    expect(r.observations.ogType).toBe('article');
    expect(r.observations.signals).toEqual({
      hasPrice: false,
      hasPublishDate: true,
      hasAuthor: true,
      hasH1: true,
    });
  });

  /** What it NO LONGER decides: not the role, not eligibility, not the weight. */
  it('returns no type, cardEligible or cardPriority', () => {
    const r = resolvePageDisplayMetadata({
      url: 'https://example.com/projects/acme',
      title: 'Acme Tower | Example Studio',
      html: '<html><body><h1>Acme Tower</h1></body></html>',
    });
    expect(r).not.toHaveProperty('type');
    expect(r).not.toHaveProperty('cardEligible');
    expect(r).not.toHaveProperty('cardPriority');
    expect(r.displayTitle).toBe('Acme Tower');
  });

  it('works without html at all', () => {
    const r = resolvePageDisplayMetadata({ url: 'https://example.com/a/b', title: 'A' });
    expect(r.observations.schemaTypes).toEqual([]);
    expect(r.observations.ogType).toBeUndefined();
    expect(r.observations.pathSegments).toEqual(['a', 'b']);
  });
});

describe('exported patterns — offered, not applied', () => {
  it('matches genuine utility pages', () => {
    for (const url of [
      'https://shop.example.com/checkout',
      'https://shop.example.com/cart',
      'https://example.com/login',
      'https://example.com/privacy-policy',
      'https://example.com/404',
      'https://example.com/wp-admin/',
    ]) {
      expect(matchesAny(url, DEFAULT_JUNK_URL_PATTERNS), url).toBe(true);
    }
  });

  /**
   * The reason for the change, as an assertion: `/news/` was in the hard-exclusion list and it was
   * ALWAYS applied. For an architecture firm or a publisher, news is the product — and getting it
   * back cost one backfill script per class.
   */
  it('does NOT treat editorial content as junk', () => {
    for (const url of [
      'https://example.com/news/2026/topping-out',
      'https://example.com/press/release',
      'https://example.com/blog/post',
      'https://example.com/careers',
      'https://example.com/our-firm/locations/riverside',
    ]) {
      expect(matchesAny(url, DEFAULT_JUNK_URL_PATTERNS), url).toBe(false);
    }
  });

  it('keeps retail patterns available for storefronts that want them', () => {
    expect(
      matchesAny('https://shop.example.com/inflation-buster-sale', STOREFRONT_URL_PATTERNS.promotion),
    ).toBe(true);
    expect(matchesAny('https://shop.example.com/offers/summer', STOREFRONT_URL_PATTERNS.promotion)).toBe(
      true,
    );
    // And they are not imposed on a site that is not a shop.
    expect(matchesAny('https://example.com/projects/acme', STOREFRONT_URL_PATTERNS.promotion)).toBe(
      false,
    );
  });

  it('matches junk titles when the URL says nothing', () => {
    expect(matchesAny('Thank you for your purchase', DEFAULT_JUNK_TITLE_PATTERNS)).toBe(true);
    expect(matchesAny('Riverside | Example Studio', DEFAULT_JUNK_TITLE_PATTERNS)).toBe(false);
  });
});
