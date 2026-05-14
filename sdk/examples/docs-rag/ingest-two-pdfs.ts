/**
 * Example: ingest two PDFs in one call and show global + per-document progress.
 *
 * Requires: pnpm add -D unpdf (from repo `sdk/`)
 *
 * Usage:
 *   cd sdk/examples/docs-rag
 *   npx tsx ingest-two-pdfs.ts "C:\path\a.pdf" "C:\path\b.pdf"
 *
 * Uses `onIngestProgress` → `byDocument` so each file has its own chunk counter
 * while the first line shows overall progress.
 */

import { config } from 'dotenv';
import { resolve, basename } from 'path';
import { readFileSync } from 'fs';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

config({ path: resolve(__dirname, '.env') });

function bar(done: number, total: number, w = 12): string {
  if (total <= 0) return `[${' '.repeat(w)}]`;
  const f = Math.min(w, Math.round((done / total) * w));
  return `[${'#'.repeat(f)}${'.'.repeat(w - f)}]`;
}

async function loadPdf(pdfPath: string) {
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

async function main(pathA: string, pathB: string) {
  const runId = Date.now();
  const idA = `pdf-a-${runId}`;
  const idB = `pdf-b-${runId}`;
  const labelA = basename(pathA);
  const labelB = basename(pathB);

  console.log('📄 Loading PDF A:', pathA);
  const dataA = await loadPdf(pathA);
  console.log(`   pages=${dataA.numpages} chars=${dataA.text.length}`);

  console.log('\n📄 Loading PDF B:', pathB);
  const dataB = await loadPdf(pathB);
  console.log(`   pages=${dataB.numpages} chars=${dataB.text.length}\n`);

  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'paragraph',
    maxChunkSize: 1500,
    minSimilarity: 0.25,
    cache: {
      embeddings: { enabled: true, ttl: 3600000, maxSize: 100 },
    },
  });

  const labels = new Map<string, string>([
    [idA, labelA.length > 20 ? labelA.slice(0, 17) + '…' : labelA],
    [idB, labelB.length > 20 ? labelB.slice(0, 17) + '…' : labelB],
  ]);

  try {
    console.log('📦 Ingesting both documents (watch global + per-file lines)…\n');

    const result = await plugin.ingest(
      [
        {
          id: idA,
          content: dataA.text,
          metadata: {
            title: dataA.info?.Title || labelA,
            filename: labelA,
            type: 'pdf',
            pages: dataA.numpages,
            author: dataA.info?.Author,
            createdAt: dataA.info?.CreationDate,
          },
        },
        {
          id: idB,
          content: dataB.text,
          metadata: {
            title: dataB.info?.Title || labelB,
            filename: labelB,
            type: 'pdf',
            pages: dataB.numpages,
            author: dataB.info?.Author,
            createdAt: dataB.info?.CreationDate,
          },
        },
      ],
      {
        agentId: 'two-pdf-agent',
        onIngestPlan: (plan) => {
          console.log(`📐 Plan: ${plan.totalChunks} chunks total`);
          for (const row of plan.documents) {
            const lab = labels.get(row.documentId) ?? row.documentId;
            console.log(`   • ${lab} (${row.documentId}) → ${row.chunkCount} chunks`);
          }
          console.log('');
        },
        onIngestProgress: (event) => {
          if (event.phase !== 'stored') {
            return;
          }
          const g = `Global ${bar(event.processedGlobal, event.totalGlobal)} ${event.processedGlobal}/${event.totalGlobal}`;
          const per = [idA, idB]
            .map((docId) => {
              const p = event.byDocument[docId];
              const lab = labels.get(docId) ?? docId;
              if (!p) return `${lab}: —`;
              return `${lab} ${bar(p.chunksDone, p.chunksTotal)} ${p.chunksDone}/${p.chunksTotal}`;
            })
            .join('  │  ');
          process.stdout.write(`\r${g}  │  ${per}   `);
        },
      },
    );

    process.stdout.write('\n\n');
    if (result.success) {
      console.log('✅ Ingest OK', { indexed: result.indexed, totalChunks: result.metadata?.totalChunks });
    } else {
      console.log('⚠️ Ingest finished with errors', result.errors);
    }

    console.log('\n🔍 Quick search on combined index…');
    const ctx = await plugin.retrieveContext('Summarize the main topics in these documents.', {
      agentId: 'two-pdf-agent',
    });
    console.log(`   hits: ${ctx.metadata?.count}, avgScore: ${ctx.metadata?.avgScore?.toFixed(3) ?? 'n/a'}`);
  } catch (e) {
    console.error('\n❌', e);
  } finally {
    await plugin.disconnect();
  }
}

const a = process.argv[2];
const b = process.argv[3];

if (!a || !b) {
  console.error('Usage: npx tsx ingest-two-pdfs.ts <path-to-first.pdf> <path-to-second.pdf>');
  process.exit(1);
}

main(a, b).catch(console.error);
