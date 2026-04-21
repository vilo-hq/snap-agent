/**
 * Example: Ingest HTML content into DocsRAGPlugin
 * 
 * Requires installing:
 * pnpm add cheerio html-to-text
 * 
 * Usage as URL:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-html.ts https://example.com/docs/page
 * 
 * Usage as file:
 * npx tsx ingest-html.ts path/to/file.html
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function ingestHTML(source: string) {
  console.log('🌐 Processing HTML...\n');

  let html: string;
  let sourceType: 'file' | 'url';
  let title: string;

  // 1. Determine if it is a URL or file
  if (source.startsWith('http://') || source.startsWith('https://')) {
    sourceType = 'url';
    console.log(`📥 Downloading from: ${source}`);
    const response = await fetch(source);
    html = await response.text();
    title = new URL(source).pathname;
  } else {
    sourceType = 'file';
    if (!existsSync(source)) {
      throw new Error(`File not found: ${source}`);
    }
    console.log(`📄 Reading file: ${source}`);
    html = readFileSync(source, 'utf-8');
    title = source.split('/').pop()?.replace('.html', '') || 
            source.split('\\').pop()?.replace('.html', '') || 
            'document';
  }

  // 2. Use Cheerio to extract clean content
  const $ = cheerio.load(html);
  
  // Remove unwanted elements
  $('script').remove();
  $('style').remove();
  $('nav').remove();
  $('footer').remove();
  $('.sidebar').remove();
  $('.advertisement').remove();
  
  // Extract title if it exists
  const pageTitle = $('title').text() || $('h1').first().text() || title;
  
  // Get main content (tries to find the main container)
  const mainContent = 
    $('main').html() || 
    $('article').html() || 
    $('.content').html() || 
    $('.main-content').html() ||
    $('body').html() || 
    '';

  // 3. Convert HTML to plain text (with formatting)
  const plainText = convert(mainContent, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  });

  console.log(`📝 Título: ${pageTitle}`);
  console.log(`📏 Caracteres: ${plainText.length}\n`);

  // 4. Create plugin
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
    // 5. Ingest content
    console.log('📦 Ingesting into MongoDB...');
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
      console.log(`✅ HTML ingested successfully!`);
      console.log(`   Documents: ${result.indexed}`);
      console.log(`   Strategy: ${result.metadata?.strategy}\n`);
    }

    // 6. Test search
    console.log('🔍 Testing search...');
    const context = await plugin.retrieveContext(
      'What is this page about?',
      { agentId: 'html-agent' }
    );

    console.log(`   Results: ${context.metadata?.count}`);
    console.log(`   Average score: ${context.metadata?.avgScore?.toFixed(3)}\n`);

    if (context.content) {
      console.log('📄 Content found (preview):');
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
  console.error('❌ Error: Provide a URL or path to the HTML file');
  console.log('\nUsage:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-html.ts https://example.com/docs');
  console.log('  npx tsx ingest-html.ts path/to/file.html');
  process.exit(1);
}

ingestHTML(source).catch(console.error);
