/**
 * Ejemplo: Ingerir contenido HTML en DocsRAGPlugin
 * 
 * Requiere instalar:
 * pnpm add cheerio html-to-text
 * 
 * Uso como URL:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-html.ts https://example.com/docs/page
 * 
 * Uso como archivo:
 * npx tsx ingest-html.ts path/to/file.html
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function ingestHTML(source: string) {
  console.log('🌐 Procesando HTML...\n');

  let html: string;
  let sourceType: 'file' | 'url';
  let title: string;

  // 1. Determinar si es URL o archivo
  if (source.startsWith('http://') || source.startsWith('https://')) {
    sourceType = 'url';
    console.log(`📥 Descargando desde: ${source}`);
    const response = await fetch(source);
    html = await response.text();
    title = new URL(source).pathname;
  } else {
    sourceType = 'file';
    if (!existsSync(source)) {
      throw new Error(`Archivo no encontrado: ${source}`);
    }
    console.log(`📄 Leyendo archivo: ${source}`);
    html = readFileSync(source, 'utf-8');
    title = source.split('/').pop()?.replace('.html', '') || 
            source.split('\\').pop()?.replace('.html', '') || 
            'document';
  }

  // 2. Usar Cheerio para extraer contenido limpio
  const $ = cheerio.load(html);
  
  // Remover elementos no deseados
  $('script').remove();
  $('style').remove();
  $('nav').remove();
  $('footer').remove();
  $('.sidebar').remove();
  $('.advertisement').remove();
  
  // Extraer título si existe
  const pageTitle = $('title').text() || $('h1').first().text() || title;
  
  // Obtener contenido principal (intenta encontrar el contenedor principal)
  const mainContent = 
    $('main').html() || 
    $('article').html() || 
    $('.content').html() || 
    $('.main-content').html() ||
    $('body').html() || 
    '';

  // 3. Convertir HTML a texto plano (con formato)
  const plainText = convert(mainContent, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  });

  console.log(`📝 Título: ${pageTitle}`);
  console.log(`📏 Caracteres: ${plainText.length}\n`);

  // 4. Crear plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'paragraph',
    maxChunkSize: 1500,
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000,
        maxSize: 100,
      },
    },
  });

  try {
    // 5. Ingerir el contenido
    console.log('📦 Ingiriendo en MongoDB...');
    const result = await plugin.ingest([
      {
        id: `html-${Date.now()}`,
        content: plainText,
        metadata: {
          title: pageTitle,
          source,
          type: 'html',
          sourceType,
          ...(sourceType === 'url' && { url: source }),
          ...(sourceType === 'file' && { filename: source }),
        },
      },
    ], { agentId: 'html-agent' });

    if (result.success) {
      console.log(`✅ HTML ingerido exitosamente!`);
      console.log(`   Documentos: ${result.indexed}`);
      console.log(`   Estrategia: ${result.metadata?.strategy}\n`);
    }

    // 6. Probar búsqueda
    console.log('🔍 Probando búsqueda...');
    const context = await plugin.retrieveContext(
      'What is this page about?',
      { agentId: 'html-agent' }
    );

    console.log(`   Resultados: ${context.metadata?.count}`);
    console.log(`   Score promedio: ${context.metadata?.avgScore?.toFixed(3)}\n`);

    if (context.content) {
      console.log('📄 Contenido encontrado (preview):');
      console.log(context.content.slice(0, 300) + '...\n');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const source = process.argv[2];

if (!source) {
  console.error('❌ Error: Proporciona una URL o ruta al archivo HTML');
  console.log('\nUso:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-html.ts https://example.com/docs');
  console.log('  npx tsx ingest-html.ts path/to/file.html');
  process.exit(1);
}

ingestHTML(source).catch(console.error);
