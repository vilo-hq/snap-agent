/**
 * Web RAG - crawlPage() Example (Debug / Quick Test)
 *
 * This example calls the Web RAG plugin's internal `crawlPage()` method directly
 * to validate HTML extraction (title + main content) for a single URL.
 *
 * Notes:
 * - `crawlPage()` is a private method, so we invoke it via `(plugin as any)` for testing.
 * - This example does NOT ingest/index into MongoDB (no embeddings, no storage writes).
 *
 * Run (from repo root):
 *   npx tsx sdk/examples/web-crawlpage.ts https://example.com
 */

import { WebRAGPlugin } from '../../../plugins/rag/cms/src/WebRAGPlugin';
import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const url = process.argv[2] || 'https://example.com/';
  const args = new Set(process.argv.slice(3));
  const full = args.has('--full') || args.has('--print-full');
  const save = args.has('--save') || args.has('--out');
  const debugHtml = args.has('--debug-html') || args.has('--debug');
  const rendered = args.has('--render') || args.has('--rendered');

  const plugin = new WebRAGPlugin({
    // These are required by the constructor, but are not used by crawlPage().
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/agents',
    dbName: process.env.MONGODB_DB || 'agents',
    tenantId: process.env.TENANT_ID || 'local',
    openaiApiKey: process.env.OPENAI_API_KEY || 'sk-dummy',
  } as any);

  const timeoutMs = Number(process.env.CRAWL_TIMEOUT_MS || 30000);
  const debugHtmlChars = Number(process.env.DEBUG_HTML_CHARS || 1200);
  const debugTextChars = Number(process.env.DEBUG_TEXT_CHARS || 800);

  if (debugHtml) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SnapAgent-Web-Crawler/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = response.headers.get('content-type') || '';
    console.log('Debug fetch:');
    console.log('- status:', response.status);
    console.log('- content-type:', contentType || '(missing)');

    const html = await response.text();
    console.log('- htmlChars:', html.length);
    console.log('\n--- RAW HTML PREVIEW START ---\n');
    console.log(html.slice(0, debugHtmlChars));
    console.log('\n--- RAW HTML PREVIEW END ---\n');

    if (contentType.includes('text/html')) {
      const bodyText = stripHtml(html);
      console.log('Debug extraction (no selectors):');
      console.log('- bodyTextChars:', bodyText.length);
      console.log('\n--- BODY TEXT PREVIEW START ---\n');
      console.log(bodyText.slice(0, debugTextChars));
      console.log('\n--- BODY TEXT PREVIEW END ---\n');
    }
  }

  const config = {
    // Tweak these selectors per-site if needed.
    contentSelector: process.env.CONTENT_SELECTOR || 'article, main, .content, .post-content, #content, [role="main"]',
    titleSelector: process.env.TITLE_SELECTOR || 'h1, title',
    removeSelectors: [
      'script',
      'style',
      'nav',
      'header',
      'footer',
      '.sidebar',
      '.navigation',
      '.menu',
      '.comments',
      '[role="navigation"]',
      '[role="banner"]',
    ],
    defaultType: process.env.DEFAULT_TYPE || 'page',
    // Simple type inference from URL patterns (edit to taste)
    typeFromUrl: {
      '/blog/': 'post',
      '/docs/': 'doc',
      '/help/': 'help',
    },
    metadata: {
      source: 'web-crawlpage-example',
    },
  };

  let doc: { id: string; content: string; metadata: Record<string, unknown> } | null = null;
  let renderOut: {
    renderFailure?: string;
    blockedSuspected?: boolean;
    bodyTextLengthHint?: number;
  } | undefined;

  if (rendered) {
    const out = await (plugin as any).crawlPageRendered(
      url,
      config,
      timeoutMs,
      { waitUntil: 'domcontentloaded', postRenderDelayMs: 1000, scroll: { enabled: true } },
      { log: () => {}, summary: () => undefined }
    );
    doc = out?.doc ?? null;
    if (!doc) {
      renderOut = {
        renderFailure: out?.renderFailure,
        blockedSuspected: out?.blockedSuspected,
        bodyTextLengthHint: out?.bodyTextLengthHint,
      };
    }
  } else {
    doc = await (plugin as any).crawlPage(url, config, timeoutMs);
  }

  if (!doc) {
    if (renderOut) {
      if (renderOut.blockedSuspected) {
        console.log('Render: blocked or challenge page suspected (captcha / access denied).');
      } else if (renderOut.renderFailure) {
        console.log('Render failed:', renderOut.renderFailure);
      } else {
        console.log('Render finished but extraction yielded no document (content too short or empty).');
        if (typeof renderOut.bodyTextLengthHint === 'number') {
          console.log('- bodyTextLengthHint:', renderOut.bodyTextLengthHint);
        }
      }
    } else {
      console.log('No document extracted (non-HTML or too little content).');
    }
    await plugin.disconnect();
    return;
  }

  console.log('Extracted document:\n');
  console.log(JSON.stringify(
    {
      id: doc.id,
      url: doc.metadata?.url,
      title: doc.metadata?.title,
      type: doc.metadata?.type,
      contentLength: doc.content?.length,
      contentPreview: (doc.content || '').slice(0, 500),
    },
    null,
    2
  ));

  if (full) {
    console.log('\n--- FULL CONTENT START ---\n');
    console.log(doc.content || '');
    console.log('\n--- FULL CONTENT END ---\n');
  }

  if (save) {
    const outDir = path.join(process.cwd(), 'sdk', 'examples', 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const baseName = `${doc.id || 'doc'}-${Date.now()}`;
    const jsonPath = path.join(outDir, `${baseName}.json`);
    const txtPath = path.join(outDir, `${baseName}.txt`);

    fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2), 'utf8');
    fs.writeFileSync(txtPath, doc.content || '', 'utf8');

    console.log('Saved output:');
    console.log('-', jsonPath);
    console.log('-', txtPath);
  }

  await plugin.disconnect();
}

main().catch((err) => {
  console.error('crawlPage test failed:', err);
  process.exit(1);
});

