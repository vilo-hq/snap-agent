import {
  extractRealEstateMetadata,
  formatRealEstateLine,
  hasRealEstatePrice,
  type RealEstateMetadata,
} from '../realEstateMetadata';
import type { PageAttributeExtractor, PageExtractionResult } from './types';

/**
 * Built-in real-estate listing extractor (AR Spanish vocabulary).
 *
 * NOTE: this is a vertical/locale pack and is slated to move OUT of the SDK into the host
 * application (registered via `registerPageExtractor`) once the registry API ships. It lives here
 * temporarily so real-estate extraction keeps working through the framework. See the migration plan.
 *
 * `detect()` is STRUCTURAL and conservative — it fires only on genuine listing evidence (schema.org
 * real-estate type, or an AR listing marker WITH a price), so prose/place words on non-listing pages
 * (e.g. an architecture firm's project page) are never tagged as property fields.
 */
const REAL_ESTATE_JSONLD_RE =
  /"@type"\s*:\s*"(?:Apartment|House|RealEstateListing|SingleFamilyResidence|Residence|Condominium|Townhouse)"/i;
const AR_LISTING_MARKER_RE = /\b(?:expensas|ambientes?|monoambiente)\b|m(?:2|²)\s*(?:cubiert|tot)/i;
const PRICE_SIGNAL_RE = /(?:USD|U\$S|ARS|\$)\s*\d|\d[\d.,]*\s*(?:USD|U\$S|ARS|pesos)\b/i;

export const realEstateExtractor: PageAttributeExtractor = {
  id: 'real-estate-ar',

  detect({ html }) {
    if (REAL_ESTATE_JSONLD_RE.test(html)) return 3;
    if (AR_LISTING_MARKER_RE.test(html) && PRICE_SIGNAL_RE.test(html)) return 2;
    return 0;
  },

  extract({ html }): PageExtractionResult {
    const meta = extractRealEstateMetadata(html);
    const fields = realEstateMetadataFields(meta);
    const hasAny = Object.keys(fields).length > 0 || meta.price != null;
    if (!hasAny) return { metadata: {}, contentLines: [] };

    const metadata: Record<string, unknown> = { ...fields };
    if (meta.price != null) metadata.price = meta.price;
    if (meta.currency) metadata.currency = meta.currency;

    const line = formatRealEstateLine(meta);
    return {
      metadata,
      contentLines: line ? [line] : [],
      hasPriceSignal: hasRealEstatePrice(meta),
    };
  },
};

/** Flatten RealEstateMetadata into document metadata fields (omitting empty values). */
function realEstateMetadataFields(meta: RealEstateMetadata): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (meta.operationType) fields.operationType = meta.operationType;
  if (meta.propertyType) fields.propertyType = meta.propertyType;
  if (meta.bedrooms != null) fields.bedrooms = meta.bedrooms;
  if (meta.bathrooms != null) fields.bathrooms = meta.bathrooms;
  if (meta.coveredSqMeters != null) fields.coveredSqMeters = meta.coveredSqMeters;
  if (meta.landSqMeters != null) fields.landSqMeters = meta.landSqMeters;
  if (meta.expenses != null) fields.expenses = meta.expenses;
  if (meta.expensesCurrency) fields.expensesCurrency = meta.expensesCurrency;
  if (meta.rooms != null) fields.rooms = meta.rooms;
  if (meta.ageYears != null) fields.ageYears = meta.ageYears;
  if (meta.parkingSpaces != null) fields.parkingSpaces = meta.parkingSpaces;
  if (meta.orientation) fields.orientation = meta.orientation;
  if (meta.rentPrice != null) fields.rentPrice = meta.rentPrice;
  if (meta.rentCurrency) fields.rentCurrency = meta.rentCurrency;
  if (meta.salePrice != null) fields.salePrice = meta.salePrice;
  if (meta.saleCurrency) fields.saleCurrency = meta.saleCurrency;
  if (meta.services?.length) fields.services = meta.services;
  return fields;
}
