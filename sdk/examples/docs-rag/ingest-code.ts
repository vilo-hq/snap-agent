/**
 * Example: Ingest source code into DocsRAGPlugin
 * 
 * Use cases:
 * - Semantic search for implementations
 * - Code assistant with project context
 * - Automatic code documentation
 * 
 * No additional dependencies required
 * 
 * Supports: TypeScript, JavaScript, Python, Java, C#, Go, Rust, etc.
 * 
 * Usage:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-code.ts /path/to/codebase
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

interface CodeFile {
  path: string;
  language: string;
  content: string;
  lines: number;
}

// Supported extensions and their languages
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.cpp': 'cpp',
  '.c': 'c',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
};

function scanDirectory(dir: string, baseDir: string = dir): CodeFile[] {
  const files: CodeFile[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    // Ignore node_modules, dist, build, etc.
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.git') {
      continue;
    }

    if (stat.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir));
    } else if (stat.isFile()) {
      const ext = extname(entry);
      const language = LANGUAGE_MAP[ext];
      
      if (language) {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n').length;
        const relativePath = relative(baseDir, fullPath);
        
        files.push({
          path: relativePath,
          language,
          content,
          lines,
        });
      }
    }
  }

  return files;
}

async function ingestCodebase(directory: string) {
  console.log('📁 Scanning code directory...\n');

  if (!statSync(directory).isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  // 1. Scan files
  const codeFiles = scanDirectory(directory);
  
  console.log(`📊 Statistics:`);
  console.log(`   Files found: ${codeFiles.length}`);
  
  const langStats = codeFiles.reduce((acc, file) => {
    acc[file.language] = (acc[file.language] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log(`   By language:`);
  Object.entries(langStats).forEach(([lang, count]) => {
    console.log(`     - ${lang}: ${count}`);
  });
  console.log();

  // 2. Create plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'fixed', // Fixed size better for code
    maxChunkSize: 1000, // Smaller chunks for code
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000,
        maxSize: 200,
      },
    },
  });

  try {
    // 3. Ingest each file
    console.log('📦 Ingesting files...');
    
    for (const [index, file] of codeFiles.entries()) {
      const result = await plugin.ingest([
        {
          id: `code-${file.path}`,
          content: file.content,
          metadata: {
            title: file.path,
            source: file.path,
            type: 'code',
            language: file.language,
            lines: file.lines,
            extension: extname(file.path),
          },
        },
      ], { agentId: 'code-agent' });

      if (result.success) {
        console.log(`   ✅ [${index + 1}/${codeFiles.length}] ${file.path}`);
      } else {
        console.log(`   ❌ [${index + 1}/${codeFiles.length}] ${file.path}`);
      }
    }

    console.log('\n✅ All files ingested!\n');

    // 4. Test semantic searches
    console.log('🔍 Testing code searches...\n');

    const queries = [
      'How to handle errors and exceptions?',
      'Database connection and query implementation',
      'Authentication and authorization logic',
      'API endpoint definitions',
    ];

    for (const query of queries) {
      const context = await plugin.retrieveContext(query, { 
        agentId: 'code-agent',
        topK: 3,
      });

      console.log(`Query: "${query}"`);
      console.log(`   Results: ${context.metadata?.count}`);
      if (context.metadata?.count && context.metadata.count > 0) {
        console.log(`   Archivo top: ${context.content.split('\n')[0]}`);
      }
      console.log();
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const directory = process.argv[2] || process.cwd();

console.log(`🚀 Ingesting code from: ${directory}\n`);

ingestCodebase(directory).catch(console.error);
