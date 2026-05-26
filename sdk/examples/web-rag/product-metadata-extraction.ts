/**
 * Web RAG — Product metadata extraction (Paso 1)
 *
 * Runs the same HTML extraction web-rag uses on ingest: title, description,
 * imageUrl, type, price, currency, availability, plus a content preview.
 *
 * Run from repo root:
 *
 *   # Offline: fixtures in sdk/examples/web-rag/fixtures/
 *   npx tsx sdk/examples/web-rag/product-metadata-extraction.ts
 *
 *   # Live product page
 *   npx tsx sdk/examples/web-rag/product-metadata-extraction.ts --url=https://www.example.com/product
 *
 *   # Index + retrieveContext topResults (needs .env)
 *   npx tsx sdk/examples/web-rag/product-metadata-extraction.ts --url=https://... --ingest
 *
 *   # Custom retrieval query / minScore (default minScore=0.35 for demos)
 *   npx tsx sdk/examples/web-rag/product-metadata-extraction.ts --url=... --ingest --query="gorra bulls precio" --minScore=0.3
 *
 *   # Ingest only (no vector search — e.g. DB without Atlas index)
 *   npx tsx sdk/examples/web-rag/product-metadata-extraction.ts --url=... --ingest --skip-retrieve
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import {
  extractPageFromHtml,
  urlToDocumentId,
} from '../../../plugins/rag/web/src/htmlPageExtract';
import { WebRAGPlugin } from '../../../plugins/rag/web/src/WebRAGPlugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readFloatArg(name: string, fallback: number): number {
  const v = readArg(name) ?? process.env[`RAG_${name.toUpperCase()}`];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printBlock(title: string, payload: unknown) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(title);
  console.log('─'.repeat(60));
  console.log(JSON.stringify(payload, null, 2));
}

function crawlUrlForIngest(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.href;
  } catch {
    return url;
  }
}

function buildPluginConfig() {
  const openaiKey = process.env.OPENAI_API_KEY;
  const mongoUri = process.env.MONGODB_URI;
  if (!openaiKey || !mongoUri) {
    throw new Error(
      'Missing OPENAI_API_KEY or MONGODB_URI. Copy sdk/examples/web-rag/.env.example to .env',
    );
  }

  const minScore = readFloatArg('minScore', 0.35);
  const vectorIndexName = process.env.WEB_RAG_VECTOR_INDEX || 'web_vector_index';

  return {
    plugin: new WebRAGPlugin({
      mongoUri,
      dbName: process.env.MONGODB_DB || 'agents',
      tenantId: process.env.TENANT_ID || 'local',
      openaiApiKey: openaiKey,
      minScore,
      collection: process.env.WEB_RAG_COLLECTION || 'web_content',
      vectorIndexName,
    }),
    mongoUri,
    dbName: process.env.MONGODB_DB || 'agents',
    collection: process.env.WEB_RAG_COLLECTION || 'web_content',
    tenantId: process.env.TENANT_ID || 'local',
    minScore,
    vectorIndexName,
  };
}

/** null = cannot list indexes (non-Atlas / API unavailable). */
async function vectorIndexExists(opts: {
  mongoUri: string;
  dbName: string;
  collection: string;
  indexName: string;
}): Promise<boolean | null> {
  const client = new MongoClient(opts.mongoUri);
  try {
    await client.connect();
    const col = client.db(opts.dbName).collection(opts.collection);
    const indexes = await col.listSearchIndexes().toArray();
    return indexes.some(idx => idx.name === opts.indexName);
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

function isVectorIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /vector.?search|search index|index.*not found|unknown index|requires.*Atlas/i.test(msg);
}

function printVectorIndexHelp(vectorIndexName: string, collection: string) {
  console.log(
    `\nAtlas vector search index "${vectorIndexName}" is not available on "${collection}".`,
    '\nChunks are stored in MongoDB, but retrieveContext needs a vectorSearch index.',
    '\nSee plugins/rag/web/README.md (MongoDB Index Setup) or use --skip-retrieve.',
    '\nTo attempt retrieval anyway: --force-retrieve',
  );
}

/** Shape printed by the example (matches indexed document metadata + preview). */
function formatExtractResult(url: string, html: string, label?: string) {
  const extracted = extractPageFromHtml(url, html, {
    defaultType: 'product',
    typeFromUrl: { '/blog/': 'blog', '/product': 'product', '/p': 'product' },
  });

  const ingestUrl = crawlUrlForIngest(url);

  return {
    ...(label ? { source: label } : {}),
    id: extracted.id,
    ingestDocumentId: urlToDocumentId(ingestUrl),
    ingestUrl,
    indexable: extracted.indexable,
    contentLength: extracted.content.length,
    metadata: extracted.metadata,
    contentPreview: extracted.contentPreview,
    suggestedQuery: buildSuggestedQuery(extracted.metadata.title),
  };
}

function buildSuggestedQuery(title?: unknown): string {
  if (typeof title === 'string' && title.trim()) {
    return `${title.trim()} precio`;
  }
  return 'producto precio disponibilidad';
}

async function countIndexedChunks(opts: {
  mongoUri: string;
  dbName: string;
  collection: string;
  tenantId: string;
  agentId: string;
  documentId: string;
}): Promise<number> {
  const client = new MongoClient(opts.mongoUri);
  try {
    await client.connect();
    const col = client.db(opts.dbName).collection(opts.collection);
    return await col.countDocuments({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      $or: [{ id: opts.documentId }, { documentId: opts.documentId }],
    });
  } finally {
    await client.close();
  }
}

async function runFixtures() {
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.html')).sort();
  if (files.length === 0) {
    console.warn('No .html fixtures found in', FIXTURES_DIR);
    return;
  }

  console.log(`Running ${files.length} fixture(s) from ${FIXTURES_DIR}`);

  for (const file of files) {
    const html = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    const fakeUrl = `https://example.com/fixtures/${file}`;
    printBlock(file, formatExtractResult(fakeUrl, html));
  }
}

async function runUrlFetch(url: string) {
  console.log(`Fetching: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SnapAgent-WebRAG-Example/1.0' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const result = formatExtractResult(url, html);
  printBlock('extractPageFromHtml (full metadata)', result);
  return result;
}

async function runIngestAndRetrieve(
  url: string,
  hints?: { suggestedQuery?: string; documentId?: string },
) {
  const { plugin, mongoUri, dbName, collection, tenantId, minScore, vectorIndexName } =
    buildPluginConfig();
  const agentId = process.env.AGENT_ID || 'product-metadata-demo';
  const ingestUrl = crawlUrlForIngest(url);
  const documentId = hints?.documentId ?? urlToDocumentId(ingestUrl);

  try {
    console.log(`Ingesting: ${ingestUrl}`);
    if (ingestUrl !== url) {
      console.log(`(stripQueryParams: dropped query string from stored URL)`);
    }

    const ingest = await plugin.ingestSinglePageFromUrl(
      {
        url: ingestUrl,
        type: 'product',
        defaultType: 'product',
        timeout: Number(process.env.CRAWL_TIMEOUT_MS) || 30000,
        stripQueryParams: true,
      },
      { overwrite: true, agentId },
    );

    printBlock('ingestSinglePageFromUrl', {
      success: ingest.success,
      indexed: ingest.indexed,
      failed: ingest.failed,
      urlsCrawled: ingest.urlsCrawled,
      errorsSample: ingest.errors?.slice(0, 3),
      agentId,
      documentId,
    });

    const storedChunks = await countIndexedChunks({
      mongoUri,
      dbName,
      collection,
      tenantId,
      agentId,
      documentId,
    });

    printBlock('MongoDB verify (chunks for document)', {
      collection,
      tenantId,
      agentId,
      documentId,
      chunkCount: storedChunks,
    });

    if (storedChunks === 0) {
      console.log(
        '\nNo rows in Mongo for this documentId/agentId. Check MONGODB_URI, TENANT_ID, and vector collection name.',
      );
      return;
    }

    if (hasFlag('skip-retrieve')) {
      console.log('\n--skip-retrieve: skipping retrieveContext (ingest + Mongo verify only).');
      return;
    }

    const forceRetrieve = hasFlag('force-retrieve');
    const indexPresent = await vectorIndexExists({
      mongoUri,
      dbName,
      collection,
      indexName: vectorIndexName,
    });

    printBlock('Atlas vector index check', {
      indexName: vectorIndexName,
      collection,
      status:
        indexPresent === true
          ? 'found'
          : indexPresent === false
            ? 'not_found'
            : 'unknown (listSearchIndexes unavailable)',
    });

    if (indexPresent === false && !forceRetrieve) {
      printVectorIndexHelp(vectorIndexName, collection);
      return;
    }

    const query =
      readArg('query') || hints?.suggestedQuery || buildSuggestedQuery();
    console.log(`retrieveContext (minScore=${minScore}, agentId=${agentId})`);
    console.log(`query: "${query}"`);

    let ctx;
    try {
      ctx = await plugin.retrieveContext(query, { agentId });
    } catch (err) {
      if (isVectorIndexError(err)) {
        printBlock('retrieveContext error', {
          message: err instanceof Error ? err.message : String(err),
        });
        printVectorIndexHelp(vectorIndexName, collection);
        return;
      }
      throw err;
    }

    printBlock('retrieveContext summary', {
      contentCount: ctx.metadata?.contentCount ?? 0,
      types: ctx.metadata?.types ?? [],
      contentPreview: ctx.content?.substring(0, 280) + (ctx.content && ctx.content.length > 280 ? '…' : ''),
    });

    printBlock('topResults', ctx.metadata?.topResults ?? []);

    const top = ctx.metadata?.topResults ?? [];
    if (top.length === 0) {
      console.log(
        '\nNo vector hits. Common causes:',
        '\n  • Atlas vector index missing on this DB (use --skip-retrieve if ingest-only)',
        '\n  • minScore too high — try --minScore=0.2',
        '\n  • Query mismatch — use --query with product title / language of the page',
        '\n  • Index filters: tenantId and agentId must be filter fields on the vector index',
      );
      if (indexPresent === false) {
        printVectorIndexHelp(vectorIndexName, collection);
      }
    } else {
      const withPrice = top.filter((r: { price?: number }) => r.price != null);
      if (withPrice.length === 0) {
        console.log('\nHits found but no price in topResults metadata (re-crawl may be needed).');
      }
    }
  } finally {
    await plugin.disconnect();
  }
}

async function main() {
  const url = readArg('url');
  const ingest = hasFlag('ingest');

  console.log('='.repeat(60));
  console.log('Product metadata extraction — web-rag example');
  console.log('='.repeat(60));

  await runFixtures();

  if (url) {
    const extracted = await runUrlFetch(url);
    if (ingest) {
      await runIngestAndRetrieve(url, {
        suggestedQuery: extracted.suggestedQuery,
        documentId: extracted.ingestDocumentId,
      });
    } else {
      console.log('\nTip: add --ingest to index the URL and inspect topResults via retrieveContext.');
    }
  } else if (ingest) {
    console.error('--ingest requires --url=https://...');
    process.exit(1);
  } else {
    console.log('\nTip: pass --url=<product-page> to test a live storefront page.');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
