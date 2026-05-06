/**
 * CMS RAG - ingestFromWebsite() Example (Intelligent Crawl)
 *
 * This example tests the high-level website ingestion entrypoint:
 * - Discovery: robots.txt sitemaps -> sitemap candidates -> fallback link lookup
 * - Crawl: static first, optional render fallback (render: "auto" | true | false)
 * - Debug: counters + internal events + optional artifact saving
 *
 * Run (from repo root):
 *   npx tsx sdk/examples/cms-rag/cms-ingest-website.ts https://www.example.com --maxPages=25 --maxDepth=2 --render=auto --debug
 *
 * For SPA/lazy sites (requires Playwright installed):
 *   npx tsx sdk/examples/cms-ingest-website.ts https://quotes.toscrape.com/scroll --maxPages=10 --maxDepth=1 --render=auto --debug --saveDir=sdk/examples/out
 */
import { CMSRAGPlugin } from '../../../plugins/rag/cms/src/CMSRAGPlugin';
import dotenv from 'dotenv';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readIntArg(name: string, fallback: number): number {
  const v = readArg(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function readRenderArg(): boolean | 'auto' {
  const v = (readArg('render') || 'auto').toLowerCase();
  if (v === 'true' || v === '1' || v === 'render') return true;
  if (v === 'false' || v === '0' || v === 'static') return false;
  return 'auto';
}

async function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('Usage: npx tsx sdk/examples/cms-ingest-website.ts <baseUrl> [--maxPages=25] [--maxDepth=2] [--render=auto|true|false] [--debug] [--saveDir=path]');
    process.exit(1);
  }

  const debugEnabled = process.argv.includes('--debug');
  const saveDir = readArg('saveDir');
  const forceRecrawl = process.argv.includes('--forceRecrawl');
  const ledgerEnabled = process.env.CRAWL_LEDGER_ENABLED === 'true';

  const plugin = new CMSRAGPlugin({
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/agents',
    dbName: process.env.MONGODB_DB || 'agents',
    tenantId: process.env.TENANT_ID || 'local',
    openaiApiKey: process.env.OPENAI_API_KEY || 'sk-dummy',
    crawlLedger: ledgerEnabled
      ? {
        enabled: true,
        collection: process.env.CRAWL_LEDGER_COLLECTION || 'cms_crawl_ledger',
        ttlMsIndexed: process.env.CRAWL_LEDGER_TTL_INDEXED_MS
          ? Number(process.env.CRAWL_LEDGER_TTL_INDEXED_MS)
          : undefined,
        ttlMsFailure: process.env.CRAWL_LEDGER_TTL_FAILURE_MS
          ? Number(process.env.CRAWL_LEDGER_TTL_FAILURE_MS)
          : undefined,
        ttlMsRenderError: process.env.CRAWL_LEDGER_TTL_RENDER_ERROR_MS
          ? Number(process.env.CRAWL_LEDGER_TTL_RENDER_ERROR_MS)
          : undefined,
      }
      : undefined,
  } as any);

  const maxPages = readIntArg('maxPages', 25);
  const maxDepth = readIntArg('maxDepth', 2);
  const timeout = readIntArg('timeout', 30000);
  const concurrency = readIntArg('concurrency', 3);
  const delayMs = readIntArg('delayMs', 500);
  const render = readRenderArg();

  console.log('Running ingestFromWebsite with:');
  console.log(JSON.stringify({
    baseUrl, maxPages, maxDepth, timeout, concurrency, delayMs, render, debugEnabled, saveDir,
    ledgerEnabled, forceRecrawl,
  }, null, 2));
  console.log('');

  const result = await plugin.ingestFromWebsite(
    {
      baseUrl,
      maxPages,
      maxDepth,
      timeout,
      concurrency,
      delayMs,
      stripQueryParams: true,
      render,
      renderOptions: {
        // If render === "auto", fallback to Playwright when static extract is too small
        minContentLength: 200,
        waitUntil: 'domcontentloaded',
        postRenderDelayMs: 1200,
        scroll: { enabled: true, maxScrolls: 12, scrollDelayMs: 750, stableIterations: 2 },
      },
      // Optional extraction tuning
      contentSelector: process.env.CONTENT_SELECTOR || 'article, main, .content, .post-content, #content, [role="main"]',
      titleSelector: process.env.TITLE_SELECTOR || 'h1, title',
      defaultType: process.env.DEFAULT_TYPE || 'page',
      debug: debugEnabled
        ? {
          enabled: true,
          level: 'summary',
          saveDir,
        }
        : undefined,
      crawlLedger: ledgerEnabled ? { enabled: true } : undefined,
    },
    { overwrite: true, forceRecrawl }
  );

  console.log('Crawl result:\n');
  console.log(JSON.stringify(
    {
      success: result.success,
      indexed: result.indexed,
      failed: result.failed,
      urlsCrawled: result.urlsCrawled,
      urlsFailed: result.urlsFailed,
      urlsSkipped: result.urlsSkipped,
      metadata: result.metadata,
      errorsSample: result.errors?.slice(0, 5),
    },
    null,
    2
  ));

  await plugin.disconnect();
}

main().catch((err) => {
  console.error('ingestFromWebsite example failed:', err);
  process.exit(1);
});

