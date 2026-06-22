import { describe, it, expect, afterEach } from 'vitest';
import {
  registerPageExtractor,
  unregisterPageExtractor,
  getRegisteredPageExtractors,
  runPageExtractors,
  type PageAttributeExtractor,
} from '../src/pageExtractors';

// A throwaway extractor that fires only when the HTML contains a marker, tagged with a confidence.
function markerExtractor(id: string, marker: string, score: number, field: string): PageAttributeExtractor {
  return {
    id,
    detect: ({ html }) => (html.includes(marker) ? score : 0),
    extract: () => ({ metadata: { [field]: id }, contentLines: [`${id} line`], hasPriceSignal: id === 'priced' }),
  };
}

describe('pageExtractors registry', () => {
  const added: string[] = [];
  const add = (x: PageAttributeExtractor) => { registerPageExtractor(x); added.push(x.id); };
  afterEach(() => { added.splice(0).forEach(unregisterPageExtractor); });

  it('built-in ecommerce-variants is registered by default', () => {
    expect(getRegisteredPageExtractors().some((x) => x.id === 'ecommerce-variants')).toBe(true);
  });

  it('runs only extractors whose detect() matches the page', () => {
    add(markerExtractor('alpha', '@@A', 1, 'a'));
    add(markerExtractor('beta', '@@B', 1, 'b'));
    const r = runPageExtractors({ html: '<html>@@A only</html>' });
    expect(r.matched).toContain('alpha');
    expect(r.matched).not.toContain('beta');
    expect(r.metadata.a).toBe('alpha');
    expect(r.contentLines).toContain('alpha line');
  });

  it('orders by confidence — higher detect() wins on a metadata key collision', () => {
    add({ id: 'lo', detect: () => 1, extract: () => ({ metadata: { shared: 'lo' }, contentLines: [] }) });
    add({ id: 'hi', detect: () => 5, extract: () => ({ metadata: { shared: 'hi' }, contentLines: [] }) });
    const r = runPageExtractors({ html: '<html></html>' });
    expect(r.matched.indexOf('hi')).toBeLessThan(r.matched.indexOf('lo'));
    expect(r.metadata.shared).toBe('hi'); // highest-confidence writer keeps the key
  });

  it('disable skips an extractor; force runs one whose detect() returned 0', () => {
    add(markerExtractor('alpha', '@@A', 1, 'a'));
    const disabled = runPageExtractors({ html: '<html>@@A</html>' }, { disable: ['alpha'] });
    expect(disabled.matched).not.toContain('alpha');

    const forced = runPageExtractors({ html: '<html>no marker</html>' }, { force: ['alpha'] });
    expect(forced.matched).toContain('alpha'); // ran despite detect() === 0
  });

  it('aggregates hasPriceSignal across matched extractors', () => {
    add(markerExtractor('priced', '@@P', 1, 'p'));
    expect(runPageExtractors({ html: '<html>@@P</html>' }).hasPriceSignal).toBe(true);
    expect(runPageExtractors({ html: '<html>none</html>' }).hasPriceSignal).toBe(false);
  });
});
