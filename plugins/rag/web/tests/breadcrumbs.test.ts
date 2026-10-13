import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { readBreadcrumbs } from '../src/breadcrumbs';
import { resolvePageDisplayMetadata } from '../src/pageCardMetadata';

const PRODUCT_URL = 'https://shop.example.com/productos/top-ellis-rosa-6cpan/';
const read = (html: string, url = PRODUCT_URL) => readBreadcrumbs(cheerio.load(html), url);

/** Trimmed from a real Tiendanube product page: the trail sits inside `WebPage.breadcrumb`. */
const TIENDANUBE_JSONLD = `<script type="application/ld+json">{
  "@context": "https://schema.org", "@type": "WebPage", "name": "Top Ellis Rosa",
  "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Inicio", "item": "https://shop.example.com" },
    { "@type": "ListItem", "position": 2, "name": "NUEVA COLECCIÓN ", "item": "https://shop.example.com/nueva-coleccion/" },
    { "@type": "ListItem", "position": 3, "name": "Tops, camisas y remeras", "item": "https://shop.example.com/nueva-coleccion/tops-camisas-y-remeras/" },
    { "@type": "ListItem", "position": 4, "name": "Top Ellis Rosa", "item": "https://shop.example.com/productos/top-ellis-rosa-6cpan/" }
  ]},
  "mainEntity": { "@type": "Product", "name": "Top Ellis Rosa" }
}</script>`;

/** The same trail as the theme renders it, with no JSON-LD. */
const TIENDANUBE_HTML = `<div class="breadcrumbs">
  <a class="crumb" href="https://shop.example.com" title="Tienda">Inicio</a>
  <span class="separator">.</span>
  <a class="crumb" href="/nueva-coleccion/">NUEVA COLECCIÓN </a>
  <span class="separator">.</span>
  <a class="crumb" href="/nueva-coleccion/tops-camisas-y-remeras/">Tops, camisas y remeras</a>
  <span class="separator">.</span>
  <span class="crumb active">Top Ellis Rosa</span>
</div>`;

const SECTIONS = [
  { name: 'NUEVA COLECCIÓN', url: 'https://shop.example.com/nueva-coleccion/' },
  { name: 'Tops, camisas y remeras', url: 'https://shop.example.com/nueva-coleccion/tops-camisas-y-remeras/' },
];

describe('readBreadcrumbs — the sections a page says it sits in', () => {
  it('reads a BreadcrumbList nested in the WebPage, without home and without the page itself', () => {
    expect(read(`<html><head>${TIENDANUBE_JSONLD}</head><body></body></html>`)).toEqual(SECTIONS);
  });

  it('falls back to the trail the theme renders: links in order, separators and the active step left out', () => {
    expect(read(`<html><body>${TIENDANUBE_HTML}<h1>Top Ellis Rosa</h1></body></html>`)).toEqual(SECTIONS);
  });

  it('prefers the JSON-LD when both are there', () => {
    const html = `<html><head>${TIENDANUBE_JSONLD}</head><body><nav class="breadcrumb"><a href="/otra/">Otra cosa</a></nav></body></html>`;
    expect(read(html)).toEqual(SECTIONS);
  });

  it('a listing whose trail ends in itself has no sections above it', () => {
    const html = `<script type="application/ld+json">{"@type":"WebPage","breadcrumb":{"@type":"BreadcrumbList","itemListElement":[
      {"position":1,"name":"Inicio","item":"https://shop.example.com"},
      {"position":2,"name":"NUEVA COLECCIÓN","item":"https://shop.example.com/nueva-coleccion/"}]}}</script>`;
    expect(read(html, 'https://shop.example.com/nueva-coleccion/')).toEqual([]);
  });

  it('orders by position and reads `item` as an object', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"BreadcrumbList","itemListElement":[
      {"position":3,"item":{"@id":"https://www.example.org/projects/riverside/","name":"Riverside"}},
      {"position":1,"item":{"@id":"https://www.example.org/","name":"Home"}},
      {"position":2,"item":{"@id":"https://www.example.org/projects/","name":"Projects"}}]}]}</script>`;
    expect(read(html, 'https://example.org/projects/riverside')).toEqual([{ name: 'Projects', url: 'https://www.example.org/projects/' }]);
  });

  it('reads an `ol > li` trail with an aria-current last step', () => {
    const html = `<nav aria-label="Breadcrumb"><ol>
      <li><a href="/">Home</a></li><li>/</li><li><a href="/women/">Women</a></li>
      <li><a href="/women/dresses/">Dresses</a></li><li aria-current="page">Linen dress</li></ol></nav>`;
    expect(read(html, 'https://shop.example.com/p/linen-dress')).toEqual([
      { name: 'Women', url: 'https://shop.example.com/women/' },
      { name: 'Dresses', url: 'https://shop.example.com/women/dresses/' },
    ]);
  });

  it('nested trail containers are read once', () => {
    const html = `<div class="breadcrumbs-wrapper"><ul class="breadcrumb"><li><a href="/">Home</a></li><li><a href="/sale/">Sale</a></li><li>Linen dress</li></ul></div>`;
    expect(read(html, 'https://shop.example.com/p/linen-dress')).toEqual([{ name: 'Sale', url: 'https://shop.example.com/sale/' }]);
  });

  it('no trail, no sections', () => {
    expect(read('<html><body><h1>Contacto</h1><p>Escribinos.</p></body></html>')).toEqual([]);
  });
});

describe('observations carry the breadcrumb as evidence', () => {
  it('present when the page shows a trail, absent otherwise', () => {
    const withTrail = resolvePageDisplayMetadata({ url: PRODUCT_URL, title: 'Top Ellis Rosa', html: `<html><head>${TIENDANUBE_JSONLD}</head></html>` });
    expect(withTrail.observations.breadcrumbs).toEqual(SECTIONS);
    const without = resolvePageDisplayMetadata({ url: PRODUCT_URL, title: 'Contacto', html: '<html><body><h1>Contacto</h1></body></html>' });
    expect(without.observations).not.toHaveProperty('breadcrumbs');
  });
});
