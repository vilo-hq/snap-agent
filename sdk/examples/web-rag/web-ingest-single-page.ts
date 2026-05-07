/**
 * Web RAG - ingestSinglePageFromUrl() Example
 *
 * Ingests exactly one URL: no sitemap, no link discovery.
 * Same crawl pipeline as website ingest (static → optional render fallback).
 *
 * Run (from repo root):
 *   npx tsx sdk/examples/web-rag/web-ingest-single-page.ts https://www.example.com/path --render=auto --debug
 *
 * Force re-crawl ignoring ledger TTL:
 *   npx tsx sdk/examples/web-rag/web-ingest-single-page.ts https://... --forceRecrawl
 */
import { WebRAGPlugin } from '../../../plugins/rag/cms/src/WebRAGPlugin';
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
  const url = process.argv[2];
  if (!url) {
    console.error(
      'Usage: npx tsx sdk/examples/web-rag/web-ingest-single-page.ts <url> [--render=auto|true|false] [--timeout=30000] [--debug] [--saveDir=path] [--forceRecrawl]'
    );
    process.exit(1);
  }

  const debugEnabled = process.argv.includes('--debug');
  const saveDir = readArg('saveDir');
  const forceRecrawl = process.argv.includes('--forceRecrawl');
  const ledgerEnabled = process.env.CRAWL_LEDGER_ENABLED === 'true';
  const agentId = process.env.AGENT_ID || 'shared';

  const plugin = new WebRAGPlugin({
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/agents',
    dbName: process.env.MONGODB_DB || 'agents',
    tenantId: process.env.TENANT_ID || 'local',
    openaiApiKey: process.env.OPENAI_API_KEY || 'sk-dummy',
    crawlLedger: ledgerEnabled
      ? {
        enabled: true,
        collection: process.env.CRAWL_LEDGER_COLLECTION || 'web_crawl_ledger',
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

  const timeout = readIntArg('timeout', 30000);
  const render = readRenderArg();

  console.log('Running ingestSinglePageFromUrl with:');
  console.log(JSON.stringify({
    url, timeout, render, debugEnabled, saveDir, ledgerEnabled, forceRecrawl, agentId,
  }, null, 2));
  console.log('');

  const result = await plugin.ingestSinglePageFromUrl(
    {
      url,
      timeout,
      stripQueryParams: true,
      render,
      renderOptions: {
        minContentLength: 200,
        waitUntil: 'domcontentloaded',
        postRenderDelayMs: 1200,
        scroll: { enabled: true, maxScrolls: 12, scrollDelayMs: 750, stableIterations: 2 },
      },
      ...(process.env.CONTENT_SELECTOR
        ? { contentSelector: process.env.CONTENT_SELECTOR }
        : {}),
      ...(process.env.TITLE_SELECTOR ? { titleSelector: process.env.TITLE_SELECTOR } : {}),
      type: process.env.DEFAULT_TYPE || 'page',
      debug: debugEnabled
        ? {
          enabled: true,
          level: 'summary',
          saveDir,
        }
        : undefined,
      crawlLedger: ledgerEnabled ? { enabled: true } : undefined,
    },
    { overwrite: true, forceRecrawl, agentId }
  );

  console.log('Result:\n');
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
  console.error('ingestSinglePageFromUrl example failed:', err);
  process.exit(1);
});
