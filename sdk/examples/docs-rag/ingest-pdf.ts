/**
 * Example: Ingest PDF documents into DocsRAGPlugin
 * 
 * Requires installing:
 * pnpm add pdf-parse -D @types/pdf-parse
 * 
 * Usage:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-pdf.ts path/to/document.pdf
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import pdf from 'pdf-parse';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function ingestPDF(pdfPath: string) {
  console.log('📄 Extracting text from PDF...\n');

  // 1. Read PDF file
  const dataBuffer = readFileSync(pdfPath);
  const pdfData = await pdf(dataBuffer);

  console.log(`📊 Pages: ${pdfData.numpages}`);
  console.log(`📝 Characters: ${pdfData.text.length}\n`);

  // 2. Create plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'paragraph',  // Better for PDFs without markdown
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
    // 3. Ingest PDF content
    const filename = pdfPath.split('/').pop() || pdfPath.split('\\').pop() || pdfPath;
    
    console.log('📦 Ingesting into MongoDB...');
    const result = await plugin.ingest([
      {
        id: `pdf-${Date.now()}`,
        content: pdfData.text,
        metadata: {
          title: pdfData.info?.Title || filename,
          filename,
          type: 'pdf',
          pages: pdfData.numpages,
          author: pdfData.info?.Author,
          createdAt: pdfData.info?.CreationDate,
        },
      },
    ], { agentId: 'pdf-agent' });

    if (result.success) {
      console.log(`✅ PDF ingested successfully!`);
      console.log(`   Documents: ${result.indexed}`);
      console.log(`   Strategy: ${result.metadata?.strategy}\n`);
    }

    // 4. Test search
    console.log('🔍 Testing search...');
    const context = await plugin.retrieveContext(
      'What is this document about?',
      { agentId: 'pdf-agent' }
    );

    console.log(`   Results: ${context.metadata?.count}`);
    console.log(`   Average score: ${context.metadata?.avgScore?.toFixed(3)}\n`);

    if (context.sources && context.sources.length > 0) {
      console.log('📄 Fragments found:');
      context.sources.forEach((source: any, i: number) => {
        console.log(`   ${i + 1}. Score: ${source.score.toFixed(3)}`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const pdfPath = process.argv[2];

if (!pdfPath) {
  console.error('❌ Error: Provide the path to the PDF file');
  console.log('\nUsage:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-pdf.ts path/to/document.pdf');
  process.exit(1);
}

ingestPDF(pdfPath).catch(console.error);
