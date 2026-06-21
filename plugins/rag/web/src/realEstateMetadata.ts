import * as cheerio from 'cheerio';
import { normalizeCurrency, parsePrice } from './productMetadata';

export interface RealEstateMetadata {
  price?: number;
  currency?: string;
  operationType?: 'sale' | 'rent';
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  coveredSqMeters?: number;
  landSqMeters?: number;
  /** Monthly building expenses (expensas). */
  expenses?: number;
  expensesCurrency?: string;
  /** Total rooms (ambientes), distinct from bedrooms. */
  rooms?: number;
  ageYears?: number;
  parkingSpaces?: number;
  orientation?: string;
  rentPrice?: number;
  rentCurrency?: string;
  salePrice?: number;
  saleCurrency?: string;
  /** Utilities and amenities listed on the property (e.g. Agua corriente, Gas natural). */
  services?: string[];
}

const REAL_ESTATE_JSON_LD_TYPES = new Set([
  'apartment',
  'house',
  'realestatelisting',
  'singlefamilyresidence',
  'residence',
  'condominium',
  'townhouse',
]);

const AR_PROPERTY_TYPE_WORDS = new Set([
  'departamento',
  'depto',
  'casa',
  'ph',
  'loft',
  'local',
  'oficina',
  'terreno',
  'cochera',
  'duplex',
  'dúplex',
  'penthouse',
  'monoambiente',
  'semipiso',
  'piso',
  'galpon',
  'galpón',
  'depósito',
  'deposito',
]);

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  departamento: 'Departamento',
  depto: 'Departamento',
  casa: 'Casa',
  ph: 'PH',
  loft: 'Loft',
  local: 'Local',
  oficina: 'Oficina',
  terreno: 'Terreno',
  cochera: 'Cochera',
  monoambiente: 'Monoambiente',
};

const ORIENTATION_MAP: Record<string, string> = {
  n: 'N',
  s: 'S',
  e: 'E',
  o: 'O',
  ne: 'NE',
  no: 'NO',
  se: 'SE',
  so: 'SO',
  noreste: 'NE',
  noroeste: 'NO',
  sudeste: 'SE',
  sudoeste: 'SO',
  norte: 'N',
  sur: 'S',
  este: 'E',
  oeste: 'O',
};

const AMOUNT =
  String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{4,}(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const M2 = String.raw`m(?:2|²)`;

/** Known utility/amenity labels on AR listing sites (order: more specific first). */
const LISTING_SERVICE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bagua\s+caliente\s+central\b/i, label: 'Agua caliente central' },
  { re: /\bagua\s+corriente\b/i, label: 'Agua corriente' },
  { re: /\bagua\s+caliente\b/i, label: 'Agua caliente' },
  { re: /\bgas\s+natural\b/i, label: 'Gas natural' },
  { re: /\bconexi[oó]n\s+el[eé]ctrica\b/i, label: 'Conexión eléctrica' },
  { re: /\belectricidad\b/i, label: 'Electricidad' },
  { re: /\bdesag[uü]e\s+cloacal\b/i, label: 'Desagüe cloacal' },
  { re: /\btelevisi[oó]n\s+por\s+cable\b/i, label: 'Televisión por cable' },
  { re: /\bgrupo\s+electr[oó]geno\b/i, label: 'Grupo electrógeno' },
  { re: /\bport[oó]n\s+autom[aá]tico\b/i, label: 'Portón automático' },
  { re: /\baire\s+acondicionado\s+central\b/i, label: 'Aire acondicionado central' },
  { re: /\baire\s+acondicionado\b/i, label: 'Aire acondicionado' },
  { re: /\bcalefacci[oó]n\s+central\b/i, label: 'Calefacción central' },
  { re: /\bcalefacci[oó]n\b/i, label: 'Calefacción' },
  { re: /\bascensor\b/i, label: 'Ascensor' },
  { re: /\bvigilancia\b/i, label: 'Vigilancia' },
  { re: /\bcisterna\b/i, label: 'Cisterna' },
  { re: /\bgimnasio\b/i, label: 'Gimnasio' },
  { re: /\b(pileta|piscina)\s+climatizada\b/i, label: 'Pileta climatizada' },
  { re: /\b(pileta|piscina)\b/i, label: 'Pileta' },
  { re: /\bparrilla\b/i, label: 'Parrilla' },
  { re: /\blaundry\b/i, label: 'Laundry' },
  { re: /\babl\b/i, label: 'ABL' },
];

/**
 * Extract structured real-estate fields from HTML (JSON-LD + AR listing heuristics).
 * JSON-LD is preferred; HTML heuristics fill gaps across Salas, REMAX, Argenprop, etc.
 */
export function extractRealEstateMetadata(html: string): RealEstateMetadata {
  const $ = cheerio.load(html);

  const fromJsonLd = extractFromJsonLd($);
  const fromHtml = extractFromHtmlHeuristics($);

  const result: RealEstateMetadata = {};

  mergePartial(result, fromHtml);
  overwritePartial(result, fromJsonLd);

  applyPrimaryPrice(result);

  return result;
}

/** True when any listing price was extracted (including dual rent/sale). */
export function hasRealEstatePrice(meta: RealEstateMetadata): boolean {
  return (
    meta.price != null ||
    meta.rentPrice != null ||
    meta.salePrice != null
  );
}

/** Append property attributes to indexed content so they are searchable. */
export function formatRealEstateLine(meta: RealEstateMetadata): string {
  const parts: string[] = [];
  if (meta.operationType === 'sale') parts.push('En venta / for sale.');
  if (meta.operationType === 'rent') parts.push('En alquiler / for rent.');
  if (meta.propertyType) parts.push(`Tipo: ${meta.propertyType}.`);
  if (meta.rooms != null) parts.push(`${meta.rooms} ambientes / rooms.`);
  if (meta.bedrooms != null) parts.push(`${meta.bedrooms} dormitorios / bedrooms.`);
  if (meta.bathrooms != null) parts.push(`${meta.bathrooms} baños / bathrooms.`);
  if (meta.coveredSqMeters != null) {
    parts.push(`${meta.coveredSqMeters} m² cubiertos / covered sqm.`);
  }
  if (meta.landSqMeters != null) {
    parts.push(`${meta.landSqMeters} m² totales / total sqm.`);
  }
  if (meta.expenses != null) {
    const cur = meta.expensesCurrency ?? 'ARS';
    parts.push(`Expensas / expenses: ${meta.expenses} ${cur}.`);
  }
  if (meta.ageYears != null) parts.push(`Antigüedad / age: ${meta.ageYears} años.`);
  if (meta.parkingSpaces != null) {
    parts.push(`${meta.parkingSpaces} cocheras / parking spaces.`);
  }
  if (meta.orientation) parts.push(`Orientación / orientation: ${meta.orientation}.`);
  if (meta.services?.length) {
    parts.push(`Servicios / services: ${meta.services.join(', ')}.`);
  }
  if (meta.rentPrice != null && meta.salePrice != null) {
    parts.push(
      `Alquiler / rent: ${meta.rentPrice} ${meta.rentCurrency ?? 'ARS'}. ` +
        `Venta / sale: ${meta.salePrice} ${meta.saleCurrency ?? 'USD'}.`,
    );
  }
  return parts.join(' ');
}

function mergePartial(target: RealEstateMetadata, source: RealEstateMetadata): void {
  if (target.price == null && source.price != null) target.price = source.price;
  if (!target.currency && source.currency) target.currency = source.currency;
  if (!target.operationType && source.operationType) target.operationType = source.operationType;
  if (!target.propertyType && source.propertyType) target.propertyType = source.propertyType;
  if (target.bedrooms == null && source.bedrooms != null) target.bedrooms = source.bedrooms;
  if (target.bathrooms == null && source.bathrooms != null) target.bathrooms = source.bathrooms;
  if (target.coveredSqMeters == null && source.coveredSqMeters != null) {
    target.coveredSqMeters = source.coveredSqMeters;
  }
  if (target.landSqMeters == null && source.landSqMeters != null) {
    target.landSqMeters = source.landSqMeters;
  }
  if (target.expenses == null && source.expenses != null) target.expenses = source.expenses;
  if (!target.expensesCurrency && source.expensesCurrency) {
    target.expensesCurrency = source.expensesCurrency;
  }
  if (target.rooms == null && source.rooms != null) target.rooms = source.rooms;
  if (target.ageYears == null && source.ageYears != null) target.ageYears = source.ageYears;
  if (target.parkingSpaces == null && source.parkingSpaces != null) {
    target.parkingSpaces = source.parkingSpaces;
  }
  if (!target.orientation && source.orientation) target.orientation = source.orientation;
  if (target.rentPrice == null && source.rentPrice != null) target.rentPrice = source.rentPrice;
  if (!target.rentCurrency && source.rentCurrency) target.rentCurrency = source.rentCurrency;
  if (target.salePrice == null && source.salePrice != null) target.salePrice = source.salePrice;
  if (!target.saleCurrency && source.saleCurrency) target.saleCurrency = source.saleCurrency;
  mergeServicesPartial(target, source);
}

function mergeServicesPartial(target: RealEstateMetadata, source: RealEstateMetadata): void {
  if (!source.services?.length) return;
  if (!target.services?.length) {
    target.services = [...source.services];
    return;
  }
  const seen = new Set(target.services.map(s => s.toLowerCase()));
  for (const service of source.services) {
    const key = service.toLowerCase();
    if (!seen.has(key)) {
      target.services.push(service);
      seen.add(key);
    }
  }
}

/** JSON-LD wins over HTML heuristics for any field it provides. */
function overwritePartial(target: RealEstateMetadata, source: RealEstateMetadata): void {
  if (source.price != null) target.price = source.price;
  if (source.currency) target.currency = source.currency;
  if (source.operationType) target.operationType = source.operationType;
  if (source.propertyType) target.propertyType = source.propertyType;
  if (source.bedrooms != null) target.bedrooms = source.bedrooms;
  if (source.bathrooms != null) target.bathrooms = source.bathrooms;
  if (source.coveredSqMeters != null) target.coveredSqMeters = source.coveredSqMeters;
  if (source.landSqMeters != null) target.landSqMeters = source.landSqMeters;
  if (source.expenses != null) target.expenses = source.expenses;
  if (source.expensesCurrency) target.expensesCurrency = source.expensesCurrency;
  if (source.rooms != null) target.rooms = source.rooms;
  if (source.ageYears != null) target.ageYears = source.ageYears;
  if (source.parkingSpaces != null) target.parkingSpaces = source.parkingSpaces;
  if (source.orientation) target.orientation = source.orientation;
  if (source.rentPrice != null) target.rentPrice = source.rentPrice;
  if (source.rentCurrency) target.rentCurrency = source.rentCurrency;
  if (source.salePrice != null) target.salePrice = source.salePrice;
  if (source.saleCurrency) target.saleCurrency = source.saleCurrency;
  if (source.services?.length) target.services = [...source.services];
}

function applyPrimaryPrice(result: RealEstateMetadata): void {
  if (result.price != null) return;

  if (result.rentPrice != null || result.salePrice != null) {
    if (result.rentPrice != null && result.salePrice == null) {
      result.price = result.rentPrice;
      result.currency = result.rentCurrency ?? result.currency ?? 'ARS';
      result.operationType = result.operationType ?? 'rent';
    } else if (result.salePrice != null && result.rentPrice == null) {
      result.price = result.salePrice;
      result.currency = result.saleCurrency ?? result.currency ?? 'USD';
      result.operationType = result.operationType ?? 'sale';
    } else if (result.rentPrice != null && result.salePrice != null) {
      if (result.operationType === 'sale') {
        result.price = result.salePrice;
        result.currency = result.saleCurrency ?? 'USD';
      } else {
        result.price = result.rentPrice;
        result.currency = result.rentCurrency ?? 'ARS';
        result.operationType = result.operationType ?? 'rent';
      }
    }
  }
}

function extractFromJsonLd($: cheerio.CheerioAPI): RealEstateMetadata {
  const result: RealEstateMetadata = {};

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const node of collectJsonLdNodes(parsed)) {
      const offer = pickOffer(node);
      if (!isRealEstateType(node) && !offer) continue;

      mergeJsonLdNode(result, node);
      if (offer) mergeOffer(result, offer);

      const item = node.itemOffered;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        mergeJsonLdNode(result, item as Record<string, unknown>);
      }
    }
  });

  return result;
}

function extractFromHtmlHeuristics($: cheerio.CheerioAPI): RealEstateMetadata {
  const result: RealEstateMetadata = {};

  const h1 = $('h1').first().text().trim();
  const title = $('title').text().trim();
  const bodyText = $('body').text();
  const listingText = buildListingText(title, h1, bodyText);

  extractLabeledPrices(listingText, result);
  extractGenericPrices(listingText, result);

  inferOperationType(listingText, title, h1, result);

  const propertyType =
    inferPropertyTypeFromHeading(h1) ||
    inferPropertyTypeFromText(title) ||
    inferPropertyTypeFromText(h1) ||
    inferPropertyTypeFromText(listingText.slice(0, 2000));
  if (propertyType) result.propertyType = propertyType;

  extractCounts(listingText, result);
  extractSurfaces(listingText, result);
  extractExpenses(listingText, result);
  extractAge(listingText, result);
  extractOrientation(listingText, result);
  extractServices(listingText, result);

  return result;
}

/** Focus on title + hero area; ignore footer/link blocks that pollute counts and prices. */
function buildListingText(title: string, h1: string, bodyText: string): string {
  const head = bodyText.slice(0, 6000);
  return [title, h1, head].filter(Boolean).join('\n');
}

function extractLabeledPrices(text: string, result: RealEstateMetadata): void {
  const rentMatch = text.match(
    new RegExp(String.raw`(?:\*\*)?Alquiler(?:\*\*)?\s*:?\s*(?:\$|USD|U\$S)?\s*(${AMOUNT})`, 'i'),
  );
  if (rentMatch) {
    const amount = parseArListingAmount(rentMatch[1]);
    if (amount != null && amount >= 1000) {
      result.rentPrice = amount;
      result.rentCurrency = inferCurrencyNear(text, rentMatch.index ?? 0, rentMatch[0]) ?? 'ARS';
    }
  }

  const saleMatch = text.match(
    new RegExp(
      String.raw`(?:\*\*)?Venta(?:\*\*)?[ \t]*:?[ \t]*(?:USD|U\$S|\$)?[ \t]*(${AMOUNT})(?![ \t]*(?:en|de)\b)`,
      'i',
    ),
  );
  if (saleMatch) {
    const amount = parseArListingAmount(saleMatch[1]);
    if (amount != null && amount >= 50) {
      result.salePrice = amount;
      result.saleCurrency = inferCurrencyNear(text, saleMatch.index ?? 0, saleMatch[0]) ?? 'USD';
    }
  }

  const precioMatch = text.match(
    new RegExp(String.raw`[Pp]recio:?\s*\*{0,2}(?:USD|U\$S|\$)?[ \t]*(\d[\d.]*)`, 'i'),
  );
  if (precioMatch && result.salePrice == null && result.price == null) {
    const amount = parseArListingAmount(precioMatch[1]);
    if (amount != null && amount >= 50) {
      result.salePrice = amount;
      result.saleCurrency = inferCurrencyNear(text, precioMatch.index ?? 0, precioMatch[0]) ?? 'USD';
    }
  }
}

function extractGenericPrices(text: string, result: RealEstateMetadata): void {
  if (result.rentPrice != null || result.salePrice != null || result.price != null) return;

  for (const line of text.split('\n')) {
    if (/expensa/i.test(line)) continue;

    const usdBefore = line.match(new RegExp(String.raw`(?:USD|U\$S)[ \t]+(${AMOUNT})`, 'i'));
    if (usdBefore) {
      const amount = parseArListingAmount(usdBefore[1]);
      if (amount != null && amount >= 50) {
        result.price = amount;
        result.currency = 'USD';
        return;
      }
    }

    const usdAfter = line.match(new RegExp(String.raw`(${AMOUNT})[ \t]+(?:USD|U\$S)\b`, 'i'));
    if (usdAfter) {
      const amount = parseArListingAmount(usdAfter[1]);
      if (amount != null && amount >= 50) {
        result.price = amount;
        result.currency = 'USD';
        return;
      }
    }

    const arsAfter = line.match(new RegExp(String.raw`(${AMOUNT})[ \t]+(?:ARS|pesos)\b`, 'i'));
    if (arsAfter) {
      const amount = parseArListingAmount(arsAfter[1]);
      if (amount != null && amount >= 1000) {
        result.price = amount;
        result.currency = 'ARS';
        return;
      }
    }

    const arsDollar = line.match(/\$[ \t]+([\d.,]+)/);
    if (arsDollar) {
      const amount = parseArListingAmount(arsDollar[1]);
      if (amount != null && amount >= 1000) {
        result.price = amount;
        result.currency = 'ARS';
        return;
      }
    }
  }
}

function inferCurrencyNear(text: string, index: number, snippet: string): string | undefined {
  const window = text.slice(Math.max(0, index - 20), index + snippet.length + 30);
  if (/\bUSD\b|U\$S/i.test(window) || /USD/i.test(snippet)) return 'USD';
  if (/\bARS\b|\$/i.test(window) || /\$/.test(snippet)) return 'ARS';
  return undefined;
}

function inferOperationType(
  contextText: string,
  title: string,
  h1: string,
  result: RealEstateMetadata,
): void {
  if (result.operationType) return;

  const head = `${title}\n${h1}`.toLowerCase();

  if (/\ben\s+alquiler\b/i.test(contextText) || /\balquiler\b/.test(head)) {
    result.operationType = 'rent';
    return;
  }
  if (/\ben\s+venta\b/i.test(contextText) || /\bventa\b/.test(head)) {
    result.operationType = 'sale';
    return;
  }
  if (/\b(?:comprar|alquilar)\s*>/i.test(contextText)) {
    if (/alquilar\s*>/i.test(contextText)) result.operationType = 'rent';
    else if (/comprar\s*>/i.test(contextText)) result.operationType = 'sale';
  }
}

function extractCounts(text: string, result: RealEstateMetadata): void {
  const roomsLabel = text.match(/(?<!\d)(?:Cant\.\s*)?Ambientes?:[ \t]*\*{0,2}(\d+)\*{0,2}/i);
  if (roomsLabel) result.rooms = parseInt(roomsLabel[1], 10);

  const bedroomLabel = text.match(/(?<!\d)(?:Cant\.\s*)?Dormitorios?:[ \t]*\*{0,2}(\d+)\*{0,2}/i);
  if (bedroomLabel) result.bedrooms = parseInt(bedroomLabel[1], 10);

  const bathroomLabel = text.match(/(?<!\d)(?:Cant\.\s*)?Baños?:[ \t]*\*{0,2}(\d+)\*{0,2}/i);
  if (bathroomLabel) result.bathrooms = parseInt(bathroomLabel[1], 10);

  const parkingLabel = text.match(/(?<!\d)(?:Cant\.\s*)?Cocheras?:[ \t]*\*{0,2}(\d+)\*{0,2}/i);
  if (parkingLabel) result.parkingSpaces = parseInt(parkingLabel[1], 10);

  for (const line of text.split('\n')) {
    const l = line.trim();
    if (result.rooms == null) {
      const m = l.match(/^(\d+)\s*ambientes?\b/i) || l.match(/^(\d+)ambientes?\b/i);
      if (m) result.rooms = parseInt(m[1], 10);
    }
    if (result.bedrooms == null) {
      const m = l.match(/^(\d+)\s+dormitorios?\b/i) || l.match(/^(\d+)dormitorios?\b/i);
      if (m) result.bedrooms = parseInt(m[1], 10);
    }
    if (result.bathrooms == null) {
      const m =
        l.match(/^(\d+)\s+baños?\b/i) ||
        l.match(/^(\d+)baños?\b/i) ||
        l.match(/^Baños?:?\s*(\d+)\b/i);
      if (m) result.bathrooms = parseInt(m[1], 10);
    }
    if (result.parkingSpaces == null) {
      const m = l.match(/^(\d+)\s+cocheras?\b/i) || l.match(/^(\d+)cocheras?\b/i);
      if (m) result.parkingSpaces = parseInt(m[1], 10);
    }
  }

  if (result.rooms == null) {
    const m = text.match(/(\d+)[ \t]+ambientes?\b/i) || text.match(/(\d+)ambientes?\b/i);
    if (m) result.rooms = parseInt(m[1], 10);
  }
  if (result.bedrooms == null) {
    const m = text.match(/(\d+)[ \t]+dormitorios?\b/i) || text.match(/(\d+)dormitorios?\b/i);
    if (m) result.bedrooms = parseInt(m[1], 10);
  }
  if (result.bathrooms == null) {
    const m =
      text.match(/Baños?:?[ \t]*(\d+)/i) ||
      text.match(/(\d+)[ \t]+baños?\b/i) ||
      text.match(/(\d+)baños?\b/i);
    if (m) result.bathrooms = parseInt(m[1], 10);
  }
  if (result.parkingSpaces == null) {
    const m = text.match(/(\d+)[ \t]+cocheras?\b/i) || text.match(/(\d+)cocheras?\b/i);
    if (m) result.parkingSpaces = parseInt(m[1], 10);
  }

  if (result.rooms == null) {
    const m = text.match(/(?<!\d)\bAmbientes[ \t]+(\d+)\b/i);
    if (m) result.rooms = parseInt(m[1], 10);
  }
  if (result.bedrooms == null) {
    const m = text.match(/(?<!\d)\bDormitorios[ \t]+(\d+)\b/i);
    if (m) result.bedrooms = parseInt(m[1], 10);
  }
  if (result.bathrooms == null) {
    const m = text.match(/(?<!\d)\bBaños[ \t]+(\d+)\b/i);
    if (m) result.bathrooms = parseInt(m[1], 10);
  }
}

function extractSurfaces(text: string, result: RealEstateMetadata): void {
  const coveredMatch =
    text.match(new RegExp(String.raw`(?:Sup\.?\s*)?[Cc]ubierta:?\s*\*{0,2}(\d+(?:[.,]\d+)?)\*{0,2}\s*${M2}\b`, 'i')) ||
    text.match(new RegExp(String.raw`superficie cubierta:?\s*(\d+(?:[.,]\d+)?)\s*${M2}\b`, 'i')) ||
    text.match(new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${M2}\s*[Cc]ubiert`, 'i')) ||
    text.match(new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${M2}\s*[Cc]ubierta\b`, 'i'));
  if (coveredMatch) result.coveredSqMeters = parseSqMeters(coveredMatch[1]);

  const landMatch =
    text.match(new RegExp(String.raw`superficie terreno:?\s*(\d+(?:[.,]\d+)?)\s*${M2}\b`, 'i')) ||
    text.match(new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${M2}\s*terreno\b`, 'i')) ||
    text.match(new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${M2}\s*(?:totales?|total)\b`, 'i'));
  if (landMatch) result.landSqMeters = parseSqMeters(landMatch[1]);

  const measuresMatch = text.match(
    new RegExp(String.raw`[Mm]edidas:?[^0-9]{0,12}(\d+(?:[.,]\d+)?)\s*${M2}`, 'i'),
  );
  if (measuresMatch && result.coveredSqMeters == null) {
    result.coveredSqMeters = parseSqMeters(measuresMatch[1]);
  }

  if (result.coveredSqMeters == null) {
    const gridSuperficie = text.match(/\bSuperficie\s+(\d+(?:[.,]\d+)?)\b/i);
    if (gridSuperficie) result.coveredSqMeters = parseSqMeters(gridSuperficie[1]);
  }
}

function extractExpenses(text: string, result: RealEstateMetadata): void {
  const match =
    text.match(/(?:Expensas|expensas)\s*:?\s*(?:ARS\s*)?\$?\s*(\d[\d.,]*)/i) ||
    text.match(/\+\s*\$?\s*(\d[\d.,]*)\s*expensas/i) ||
    text.match(/expensas:?\s*(?:ARS\s*)?\$?\s*(\d[\d.,]*)/i);
  if (!match) return;
  const amount = parseArListingAmount(match[1]);
  if (amount != null) {
    result.expenses = amount;
    result.expensesCurrency = /\bUSD\b|U\$S/i.test(match[0]) ? 'USD' : 'ARS';
  }
}

function extractAge(text: string, result: RealEstateMetadata): void {
  const match =
    text.match(/(?:Antigüedad|Antiguedad):?\s*\*{0,2}(\d+)\*{0,2}/i) ||
    text.match(/(\d+)\s*años?\s*antigüedad/i) ||
    text.match(/(\d+)años?\s*antigüedad/i);
  if (match) result.ageYears = parseInt(match[1], 10);
}

function extractOrientation(text: string, result: RealEstateMetadata): void {
  const match = text.match(/Orientaci[oó]n:?\s*\*{0,2}([A-Za-zÁÉÍÓÚáéíóú]+)\*{0,2}/i);
  if (!match) return;
  const key = match[1].trim().toLowerCase();
  result.orientation = ORIENTATION_MAP[key] ?? match[1].trim().toUpperCase();
}

function extractServicesBlock(text: string): string | undefined {
  const match = text.match(
    /\bServicios(?:\s+del\s+(?:departamento|edificio|inmueble|propiedad))?\b[\s:*#\-]*\n([\s\S]{0,2500}?)(?=\n\s*---|\n\s*#{1,4}\s|\n\s*Ubicaci[oó]n\b|\n\s*Consultar\b|\n\s*Buscador\b|\n\s*Datos b[aá]sicos\b|\n\s*Caracter[ií]sticas\b|\n\s*Ambientes del\b|\n\s*Instalaciones del\b)/i,
  );
  return match?.[1]?.trim();
}

function matchKnownServices(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { re, label } of LISTING_SERVICE_PATTERNS) {
    if (!re.test(text)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(label);
  }
  return found;
}

function extractServices(text: string, result: RealEstateMetadata): void {
  const block = extractServicesBlock(text);
  const fromBlock = block ? matchKnownServices(block) : [];
  if (fromBlock.length > 0) {
    result.services = fromBlock;
    return;
  }

  const fromListing = matchKnownServices(text);
  if (fromListing.length > 0) result.services = fromListing;
}

function mergeJsonLdNode(result: RealEstateMetadata, node: Record<string, unknown>): void {
  if (result.propertyType == null) {
    const propertyType = inferPropertyTypeFromSchemaType(node['@type']);
    if (propertyType) result.propertyType = propertyType;
  }

  if (result.bedrooms == null) {
    const bedrooms = parseIntField(
      node.numberOfBedrooms ?? node.numberOfRooms ?? node.bedrooms,
    );
    if (bedrooms != null) result.bedrooms = bedrooms;
  }

  if (result.bathrooms == null) {
    const bathrooms = parseIntField(node.numberOfBathroomsTotal ?? node.bathrooms);
    if (bathrooms != null) result.bathrooms = bathrooms;
  }

  if (result.coveredSqMeters == null) {
    const covered = parseQuantitativeValue(node.floorSize ?? node.floorArea);
    if (covered != null) result.coveredSqMeters = covered;
  }

  if (result.landSqMeters == null) {
    const land = parseQuantitativeValue(node.lotSize);
    if (land != null) result.landSqMeters = land;
  }
}

function mergeOffer(result: RealEstateMetadata, offer: Record<string, unknown>): void {
  if (result.price == null) {
    const price = parsePrice(offer.price ?? offer.lowPrice ?? offer.highPrice);
    if (price != null) result.price = price;
  }

  if (!result.currency) {
    const currency = normalizeCurrency(offer.priceCurrency);
    if (currency) result.currency = currency;
  }

  if (!result.operationType) {
    const operationType = inferOperationTypeFromOffer(offer);
    if (operationType) result.operationType = operationType;
  }
}

function collectJsonLdNodes(data: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    nodes.push(obj);

    if (obj['@graph']) visit(obj['@graph']);
  };

  visit(data);
  return nodes;
}

function isRealEstateType(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : type != null ? [type] : [];
  return types.some(t => {
    const s = String(t).toLowerCase();
    const name = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
    return REAL_ESTATE_JSON_LD_TYPES.has(name);
  });
}

function pickOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const offers = node.offers;
  if (offers == null) return null;

  if (Array.isArray(offers)) {
    const first = offers.find(o => o && typeof o === 'object') as Record<string, unknown> | undefined;
    return first ?? null;
  }
  if (typeof offers === 'object') return offers as Record<string, unknown>;
  return null;
}

function inferPropertyTypeFromSchemaType(typeValue: unknown): string | undefined {
  const type = typeValue;
  const types = Array.isArray(type) ? type : type != null ? [type] : [];
  for (const t of types) {
    const s = String(t).toLowerCase();
    const name = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
    if (name === 'apartment') return 'Departamento';
    if (name === 'house' || name === 'singlefamilyresidence') return 'Casa';
    if (name === 'townhouse') return 'PH';
  }
  return undefined;
}

function inferPropertyTypeFromHeading(heading: string): string | undefined {
  const first = heading.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const key = first.toLowerCase();
  if (AR_PROPERTY_TYPE_WORDS.has(key)) return PROPERTY_TYPE_LABELS[key] ?? capitalizeWord(first);
  return undefined;
}

function inferPropertyTypeFromText(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const word of AR_PROPERTY_TYPE_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(lower)) return PROPERTY_TYPE_LABELS[word] ?? capitalizeWord(word);
  }
  return undefined;
}

function capitalizeWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function inferOperationTypeFromOffer(
  offer: Record<string, unknown>,
): RealEstateMetadata['operationType'] | undefined {
  const category = String(offer.category ?? offer.businessFunction ?? '').toLowerCase();
  if (/rent|lease|alquiler|alquil/i.test(category)) return 'rent';
  if (/sale|sell|venta/i.test(category)) return 'sale';
  return undefined;
}

function parseIntField(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseQuantitativeValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return parseSqMeters(value);

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return parseSqMeters(obj.value ?? obj.minValue);
  }

  return undefined;
}

function parseSqMeters(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = parseArListingAmount(String(value));
  return n != null ? Math.round(n) : undefined;
}

/** Parse AR listing amounts where dot is often a thousands separator (760.000, 2.400.000). */
export function parseArListingAmount(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return parseInt(s.replace(/\./g, ''), 10);
  }

  const singleDotThousands = s.match(/^(\d+)\.(\d{3})$/);
  if (singleDotThousands) {
    return parseInt(singleDotThousands[1] + singleDotThousands[2], 10);
  }

  return parsePrice(s);
}
