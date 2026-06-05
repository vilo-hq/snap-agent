import { describe, expect, it } from 'vitest';
import {
  hardExcludePage,
  inferTypeFromUrl,
  normalizeDisplayTitle,
  resolvePageCardMetadata,
} from '../src/pageCardMetadata';

describe('pageCardMetadata', () => {
  it('normalizes SEO title suffixes', () => {
    expect(normalizeDisplayTitle('Habitaciones | Eco Hotel Punta Brava')).toBe('Habitaciones');
  });

  it('hard excludes thank-you pages', () => {
    expect(hardExcludePage('https://hotel.com/gracias-por-reservar', 'Gracias por reservar')).toBe(true);
  });

  it('infers detail from habitaciones URL', () => {
    expect(inferTypeFromUrl('https://www.puntabravachoco.com/habitaciones')).toBe('listing');
    expect(inferTypeFromUrl('https://hotel.com/rooms/superior-king')).toBe('detail');
  });

  it('classifies habitaciones as card eligible detail/listing', () => {
    const meta = resolvePageCardMetadata({
      url: 'https://www.puntabravachoco.com/habitaciones',
      title: 'Habitaciones | Eco Hotel Punta Brava',
      description: 'La habitaciones de nuestro hotel...',
    });
    expect(meta.cardEligible).toBe(true);
    expect(meta.displayTitle).toBe('Habitaciones');
  });

  it('classifies board games as amenity eligible', () => {
    const meta = resolvePageCardMetadata({
      url: 'https://www.puntabravachoco.com/service-page/juegos-de-mesa',
      title: 'JUEGOS DE MESA | Eco Hotel',
    });
    expect(meta.type).toBe('amenity');
    expect(meta.cardEligible).toBe(true);
  });

  it('excludes promotion pages from cards', () => {
    const meta = resolvePageCardMetadata({
      url: 'https://myramseyhotel.com/inflation-buster-sale/',
      title: 'Inflation Buster Sale – The Ramsey',
    });
    expect(meta.type).toBe('promotion');
    expect(meta.cardEligible).toBe(false);
  });

  it('excludes home path', () => {
    expect(hardExcludePage('https://hotel.com/', 'Home')).toBe(true);
  });

  it('infers detail for project, people, and perspective entity URLs', () => {
    expect(
      inferTypeFromUrl('https://example.com/our-work/projects/healthcare-campus'),
    ).toBe('detail');
    expect(inferTypeFromUrl('https://example.com/our-firm/people/jane-doe')).toBe('detail');
    expect(
      inferTypeFromUrl('https://example.com/our-work/perspectives/designing-for-wellness'),
    ).toBe('detail');
  });

  it('infers listing for collection index URLs', () => {
    expect(inferTypeFromUrl('https://example.com/our-work/projects')).toBe('listing');
    expect(inferTypeFromUrl('https://example.com/our-firm/people')).toBe('listing');
  });

  it('classifies professional entity pages as card eligible detail', () => {
    const meta = resolvePageCardMetadata({
      url: 'https://example.com/our-work/projects/campus-renewal',
      title: 'Campus Renewal | Example Firm',
      headingTitle: 'Campus Renewal',
    });
    expect(meta.type).toBe('detail');
    expect(meta.cardEligible).toBe(true);
    expect(meta.cardPriority).toBe(10);
    expect(meta.displayTitle).toBe('Campus Renewal');
  });
});
