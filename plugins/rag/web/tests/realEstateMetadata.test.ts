import { describe, it, expect } from 'vitest';
import {
  extractRealEstateMetadata,
  formatRealEstateLine,
  hasRealEstatePrice,
  parseArListingAmount,
} from '../src/realEstateMetadata';

const MIN_CONTENT = 'x'.repeat(60);

function wrapBody(inner: string, body = ''): string {
  return `<!DOCTYPE html><html><head>${inner}</head><body>${body || `<main><p>${MIN_CONTENT}</p></main>`}</body></html>`;
}

describe('realEstateMetadata', () => {
  describe('parseArListingAmount', () => {
    it('parses AR thousands with dots', () => {
      expect(parseArListingAmount('760.000')).toBe(760000);
      expect(parseArListingAmount('2.400.000')).toBe(2400000);
      expect(parseArListingAmount('800.000')).toBe(800000);
    });
  });

  describe('extractRealEstateMetadata', () => {
    it('extracts from JSON-LD RealEstateListing + Offer', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "RealEstateListing",
          "offers": {
            "@type": "Offer",
            "price": "1400000",
            "priceCurrency": "ARS",
            "category": "ForSale"
          }
        }
        </script>
      `);

      expect(extractRealEstateMetadata(html)).toEqual({
        price: 1400000,
        currency: 'ARS',
        operationType: 'sale',
      });
    });

    it('extracts property fields from JSON-LD Apartment', () => {
      const html = wrapBody(`
        <script type="application/ld+json">
        {
          "@type": "Apartment",
          "numberOfBedrooms": 2,
          "numberOfBathroomsTotal": 1,
          "floorSize": { "@type": "QuantitativeValue", "value": 176 },
          "offers": {
            "price": "200000",
            "priceCurrency": "USD",
            "category": "ForRent"
          }
        }
        </script>
      `);

      expect(extractRealEstateMetadata(html)).toEqual({
        price: 200000,
        currency: 'USD',
        operationType: 'rent',
        propertyType: 'Departamento',
        bedrooms: 2,
        bathrooms: 1,
        coveredSqMeters: 176,
      });
    });

    it('extracts Salas-style ARS price and listing attributes from HTML', () => {
      const html = wrapBody(
        `<title>Amarras Center Torre | Salas Inmobiliaria</title>`,
        `<main>
          <h1>Departamento en venta en Puerto Madero</h1>
          <div class="price">$ 1,400,000</div>
          <ul>
            <li>2 Dormitorios</li>
            <li>Baños: 1</li>
            <li>176 m2 Cubiertos</li>
          </ul>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toEqual({
        price: 1400000,
        currency: 'ARS',
        operationType: 'sale',
        propertyType: 'Departamento',
        bedrooms: 2,
        bathrooms: 1,
        coveredSqMeters: 176,
      });
    });

    it('extracts USD price from U$S notation', () => {
      const html = wrapBody(
        `<title>Casa en alquiler</title>`,
        `<main>
          <h1>Casa en alquiler en Nordelta</h1>
          <div class="price">U$S 200,000</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 200000,
        currency: 'USD',
        operationType: 'rent',
        propertyType: 'Casa',
      });
    });

    it('extracts REMAX-style alquiler ARS listing', () => {
      const html = wrapBody(
        `<title>Departamento en alquiler 2 ambientes en Guido 1700</title>`,
        `<main>
          <nav> Alquiler > Departamento </nav>
          <h1>DEPTO EN ALQUILER 2 AMB LUMINOSO EXCELENTE</h1>
          <h2>DEPTO EN ALQUILER 2 AMB LUMINOSO EXCELENTE</h2>
          <div>760.000 ARS</div>
          <div>Expensas : 156.000 ARS</div>
          <div>36.8m² totales</div>
          <div>36.8 m² cubiertos</div>
          <div>2ambientes</div>
          <div>1baño</div>
          <div>1dormitorio</div>
          <div>47años antigüedad</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 760000,
        currency: 'ARS',
        operationType: 'rent',
        propertyType: 'Departamento',
        rooms: 2,
        bedrooms: 1,
        bathrooms: 1,
        coveredSqMeters: 37,
        landSqMeters: 37,
        expenses: 156000,
        expensesCurrency: 'ARS',
        ageYears: 47,
      });
    });

    it('extracts REMAX-style alquiler USD listing', () => {
      const html = wrapBody(
        `<title>Departamento en alquiler 2 ambientes en Arce 700</title>`,
        `<main>
          <h1>ALQUILER 2 AMBIENTES (NO ES TEMPORAL)</h1>
          <div>500 USD</div>
          <div>Expensas : 160.000 ARS</div>
          <div>37.73m² totales</div>
          <div>36 m² cubiertos</div>
          <div>2ambientes</div>
          <div>1baño</div>
          <div>1dormitorio</div>
          <div>31años antigüedad</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 500,
        currency: 'USD',
        operationType: 'rent',
        propertyType: 'Departamento',
        rooms: 2,
        bedrooms: 1,
        bathrooms: 1,
        coveredSqMeters: 36,
        expenses: 160000,
        ageYears: 31,
      });
    });

    it('extracts REMAX-style venta casa USD listing', () => {
      const html = wrapBody(
        `<title>Casa en venta 8 ambientes en Posta del Retamo 1800</title>`,
        `<main>
          <h1>VENTA CASA BARRIO SOBERANIA NACIONAL APTA CREDITO</h1>
          <div>128.000 USD</div>
          <div>269m² totales</div>
          <div>185 m² cubiertos</div>
          <div>269 m² terreno</div>
          <div>8ambientes</div>
          <div>2baños</div>
          <div>2cocheras</div>
          <div>3dormitorios</div>
          <div>29años antigüedad</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 128000,
        currency: 'USD',
        operationType: 'sale',
        propertyType: 'Casa',
        rooms: 8,
        bedrooms: 3,
        bathrooms: 2,
        parkingSpaces: 2,
        coveredSqMeters: 185,
        landSqMeters: 269,
        ageYears: 29,
      });
    });

    it('extracts Argenprop-style venta USD listing', () => {
      const html = wrapBody(
        `<title>Venta Departamento 3 dormitorios en Palermo Chico | Argenprop</title>`,
        `<main>
          <h1>TORRE BELLINI! Piso alto de revista!</h1>
          <div>USD 2.400.000</div>
          <div>+ $2.200.000 expensas</div>
          <div>Cant. Ambientes: **5**</div>
          <div>Cant. Dormitorios: **3**</div>
          <div>Cant. Baños: **4**</div>
          <div>Cant. Cocheras: **2**</div>
          <div>Orientación: **NE**</div>
          <div>Antigüedad: **17**</div>
          <div>Sup. Cubierta: **300 m2**</div>
          <div>Tipo de operación: **Venta**</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 2400000,
        currency: 'USD',
        operationType: 'sale',
        propertyType: 'Departamento',
        bedrooms: 3,
        bathrooms: 4,
        rooms: 5,
        coveredSqMeters: 300,
        parkingSpaces: 2,
        orientation: 'NE',
        ageYears: 17,
        expenses: 2200000,
        expensesCurrency: 'ARS',
      });
    });

    it('extracts Grosso-style venta listing', () => {
      const html = wrapBody(
        `<title>PASAJE PASTEUR 6548 > Casa en VENTA en Santa Fe</title>`,
        `<main>
          <h1>PASAJE PASTEUR 6548</h1>
          <p>_Medidas:_ **256,88 m2**</p>
          <p>_Precio:_ **U$S 95000**</p>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 95000,
        currency: 'USD',
        operationType: 'sale',
        propertyType: 'Casa',
        coveredSqMeters: 257,
      });
    });

    it('extracts Ureta Cortés alquiler listing', () => {
      const html = wrapBody(
        `<title>GENERAL LÓPEZ 2900 - CASA INTERNA</title>`,
        `<main>
          <h2>GENERAL LÓPEZ 2900 – CASA INTERNA</h2>
          <h3><strong>Alquiler:</strong> $800.000</h3>
          <div>Ambientes 3</div>
          <div>Superficie 80</div>
          <div>Dormitorios 2</div>
          <div>Baños 2</div>
          <div>Antigüedad 40</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      const meta = extractRealEstateMetadata(html);
      expect(meta).toMatchObject({
        price: 800000,
        currency: 'ARS',
        operationType: 'rent',
        propertyType: 'Casa',
        rooms: 3,
        bedrooms: 2,
        bathrooms: 2,
        coveredSqMeters: 80,
        ageYears: 40,
        rentPrice: 800000,
        rentCurrency: 'ARS',
      });
    });

    it('extracts Ureta Cortés dual rent and sale listing', () => {
      const html = wrapBody(
        `<title>JAVIER DE LA ROSA 100</title>`,
        `<main>
          <h2>JAVIER DE LA ROSA 100</h2>
          <h3><strong>Alquiler:</strong> $400.000 | <strong>Venta:</strong> USD35.000</h3>
          <div>Ambientes 1</div>
          <div>Superficie 23</div>
          <div>Dormitorios 1</div>
          <div>Baños 1</div>
          <div>Antigüedad 28</div>
          <h4>Servicios</h4>
          <div>Agua Corriente</div>
          <div>Gas Natural</div>
          <div>Conexión Eléctrica</div>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      const meta = extractRealEstateMetadata(html);
      expect(meta).toMatchObject({
        rentPrice: 400000,
        rentCurrency: 'ARS',
        salePrice: 35000,
        saleCurrency: 'USD',
        price: 400000,
        currency: 'ARS',
        operationType: 'rent',
        rooms: 1,
        bedrooms: 1,
        bathrooms: 1,
        coveredSqMeters: 23,
        ageYears: 28,
      });
      expect(meta.services).toEqual(['Agua corriente', 'Gas natural', 'Conexión eléctrica']);
      expect(hasRealEstatePrice(meta)).toBe(true);
    });

    it('extracts Argenprop-style servicios del departamento', () => {
      const html = wrapBody(
        `<title>Depto en venta Palermo</title>`,
        `<main>
          <h1>Departamento en Palermo</h1>
          <div>USD 500000</div>
          <h2>Servicios del departamento</h2>
          <div>Agua corriente</div>
          <div>Electricidad</div>
          <div>Calefacción</div>
          <h2>Ubicación</h2>
          <p>${MIN_CONTENT}</p>
        </main>`,
      );

      expect(extractRealEstateMetadata(html).services).toEqual([
        'Agua corriente',
        'Electricidad',
        'Calefacción',
      ]);
    });

    it('returns empty object when no real-estate signals', () => {
      const html = wrapBody(`<meta name="description" content="Blog post" />`);
      expect(extractRealEstateMetadata(html)).toEqual({});
    });

    it('prefers JSON-LD price over HTML heuristics', () => {
      const html = `<!DOCTYPE html><html><head><title>Casa en venta</title></head><body>
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"RealEstateListing","offers":{"@type":"Offer","price":"350000","priceCurrency":"USD","category":"ForSale"}}</script>
        <main><h1>Casa en venta</h1><div>USD 999999</div><p>${MIN_CONTENT}</p></main>
      </body></html>`;

      expect(extractRealEstateMetadata(html)).toMatchObject({
        price: 350000,
        currency: 'USD',
        operationType: 'sale',
      });
    });
  });

  describe('formatRealEstateLine', () => {
    it('builds a searchable bilingual summary line', () => {
      const line = formatRealEstateLine({
        operationType: 'sale',
        propertyType: 'Departamento',
        bedrooms: 2,
        bathrooms: 1,
        coveredSqMeters: 176,
      });

      expect(line).toContain('En venta / for sale.');
      expect(line).toContain('Tipo: Departamento.');
      expect(line).toContain('2 dormitorios / bedrooms.');
      expect(line).toContain('176 m² cubiertos / covered sqm.');
    });
  });
});
