/**
 * Example: Ingest DOCX documents into DocsRAGPlugin
 * 
 * Requires installing:
 * pnpm add mammoth
 * 
 * Usage:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-docx.ts path/to/document.docx
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import mammoth from 'mammoth';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function ingestDocx(docxPath: string) {
  console.log('📄 Extracting text from DOCX...\n');

  // 1. Read DOCX file
  // extractRawText - plain text only
  // convertToMarkdown - converts to Markdown (preserves formatting)
  const result = await mammoth.convertToMarkdown({ path: docxPath });
  
  console.log(`📝 Characters: ${result.value.length}`);
  if (result.messages.length > 0) {
    console.log(`⚠️  Warnings: ${result.messages.length}\n`);
  }

  // 2. Create plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'markdown',  // Use markdown when converting with mammoth
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
    // 3. Ingest DOCX content
    const filename = docxPath.split('/').pop() || docxPath.split('\\').pop() || docxPath;
    
    console.log('📦 Ingesting into MongoDB...');
    const ingestResult = await plugin.ingest([
      {
        id: `docx-${Date.now()}`,
        content: result.value,
        metadata: {
          title: filename.replace('.docx', ''),
          filename,
          type: 'docx',
          warnings: result.messages.length,
        },
      },
    ], { agentId: 'docx-agent' });

    if (ingestResult.success) {
      console.log(`✅ DOCX ingested successfully!`);
      console.log(`   Documents: ${ingestResult.indexed}`);
      console.log(`   Strategy: ${ingestResult.metadata?.strategy}\n`);
    }

    // 4. Test search
    console.log('🔍 Testing search...');
    const context = await plugin.retrieveContext(
      'What is this document about?',
      { agentId: 'docx-agent' }
    );

    console.log(`   Results: ${context.metadata?.count}`);
    console.log(`   Average score: ${context.metadata?.avgScore?.toFixed(3)}\n`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const docxPath = process.argv[2];

if (!docxPath) {
  console.error('❌ Error: Provide the path to the DOCX file');
  console.log('\nUsage:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-docx.ts path/to/document.docx');
  process.exit(1);
}

ingestDocx(docxPath).catch(console.error);
