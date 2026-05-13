/**
 * Example: Ingest PDF documents into DocsRAGPlugin
 *
 * Requires (from repo root or `sdk/`):
 *   pnpm add -D unpdf
 *
 * Usage:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-pdf.ts path/to/document.pdf
 *
 * Uses `unpdf` (ESM-friendly PDF.js) instead of `pdf-parse` for fewer CJS/tsx issues.
 *
 * The example prints an ingest plan (chunk counts) and a live global progress bar
 * using IngestOptions.onIngestPlan / onIngestProgress (see @snap-agent/core types).
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

function formatProgressBar(done: number, total: number, width = 28): string {
  if (total <= 0) return `[${' '.repeat(width)}] 0/0`;
  const filled = Math.min(width, Math.round((done / total) * width));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${done}/${total}`;
}

async function loadPdfForIngest(pdfPath: string) {
  const bytes = new Uint8Array(readFileSync(pdfPath));
  const pdf = await getDocumentProxy(bytes);

  const [{ totalPages, text }, metaResult] = await Promise.all([
    extractText(pdf, { mergePages: true }),
    getMeta(pdf, { parseDates: true }).catch(() => ({
      info: {} as Record<string, unknown>,
      metadata: {} as Record<string, unknown>,
    })),
  ]);

  const info = metaResult.info ?? {};
  const title = typeof info.Title === 'string' ? info.Title : undefined;
  const author = typeof info.Author === 'string' ? info.Author : undefined;
  const creation =
    info.CreationDate instanceof Date
      ? info.CreationDate.toISOString()
      : typeof info.CreationDate === 'string'
        ? info.CreationDate
        : undefined;

  return { text, numpages: totalPages, info: { Title: title, Author: author, CreationDate: creation } };
}

async function ingestPDF(pdfPath: string) {
  console.log('📄 Extracting text from PDF (unpdf)...\n');

  const pdfData = await loadPdfForIngest(pdfPath);

  console.log(`📊 Pages: ${pdfData.numpages}`);
  console.log(`📝 Characters: ${pdfData.text.length}\n`);

  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'paragraph',
    maxChunkSize: 1500,
    /** Atlas $vectorSearch scores vary; 0.7 often filters everything in small/local tests */
    minSimilarity: 0.25,
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000,
        maxSize: 100,
      },
    },
  });

  try {
    const filename = pdfPath.split('/').pop() || pdfPath.split('\\').pop() || pdfPath;

    console.log('📦 Ingesting into MongoDB...');
    const result = await plugin.ingest(
      [
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
      ],
      {
        agentId: 'pdf-agent',
        onIngestPlan: (plan) => {
          console.log(`\n📐 Plan: ${plan.totalChunks} chunk(s) across ${plan.documents.length} document(s)`);
          for (const row of plan.documents) {
            console.log(`   • ${row.documentId} → ${row.chunkCount} chunk(s)`);
          }
        },
        onIngestProgress: (event) => {
          if (event.phase === 'stored') {
            process.stdout.write(`\r⚡ ${formatProgressBar(event.processedGlobal, event.totalGlobal)}`);
          }
        },
      },
    );
    process.stdout.write('\n');

    if (result.success) {
      console.log(`✅ PDF ingested successfully!`);
      console.log(`   Documents: ${result.indexed}`);
      console.log(`   Strategy: ${result.metadata?.strategy}\n`);
    }

    console.log('🔍 Testing search...');
    const context = await plugin.retrieveContext('What is this document about?', { agentId: 'pdf-agent' });

    console.log(`   Results: ${context.metadata?.count}`);
    console.log(`   Average score: ${context.metadata?.avgScore?.toFixed(3)}\n`);

    if (context.sources && context.sources.length > 0) {
      console.log('📄 Fragments found:');
      context.sources.forEach((source: { score: number }, i: number) => {
        console.log(`   ${i + 1}. Score: ${source.score.toFixed(3)}`);
      });
    }
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

const pdfPath = process.argv[2];

if (!pdfPath) {
  console.error('❌ Error: Provide the path to the PDF file');
  console.log('\nUsage:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-pdf.ts path/to/document.pdf');
  process.exit(1);
}

ingestPDF(pdfPath).catch(console.error);
