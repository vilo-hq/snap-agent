/**
 * Example script to test DocsRAGPlugin with MongoDB
 * 
 * .env location:
 * sdk/examples/docs-rag/.env
 * 
 * Before running:
 * 1. Install dependencies: pnpm install (at the monorepo root)
 * 2. Create the .env file in sdk/examples/docs-rag/
 * 3. Configure MONGODB_URI and OPENAI_API_KEY
 * 4. Create the vector search index in Atlas
 * 
 * Usage from the monorepo root:
 * cd sdk/examples/docs-rag
 * npx tsx test-plugin.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function testDocsRAG() {
  console.log('🚀 Testing DocsRAGPlugin with MongoDB\n');

  // Validar variables de entorno
  if (!process.env.MONGODB_URI) {
    console.error('❌ Error: MONGODB_URI is not configured\n');
    console.log('📁 Create the .env file at: sdk/examples/docs-rag/.env');
    console.log('\nExample:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY is not configured\n');
    console.log('📁 Create the .env file at: sdk/examples/docs-rag/.env');
    process.exit(1);
  }

  // Create plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'test_docs',
    collection: 'docs_content',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY,
    chunkingStrategy: 'markdown',
    limit: 3,
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000,
        maxSize: 100,
      },
    },
  });

  try {
    // 1. Ingest example document
    console.log('📝 Ingesting example document...');
    
    const testDoc = {
      id: 'getting-started',
      content: `# Getting Started with API

This guide will help you get started with our API.

## Authentication

All API requests require an API key. Include it in the header:

\`\`\`bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.example.com/v1/data
\`\`\`

## Making Requests

Use standard HTTP methods:

### GET Request

\`\`\`javascript
const response = await fetch('https://api.example.com/v1/users');
const users = await response.json();
\`\`\`

### POST Request

\`\`\`javascript
const response = await fetch('https://api.example.com/v1/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John Doe', email: 'john@example.com' })
});
\`\`\`

## Rate Limits

- Free tier: 100 requests/hour
- Pro tier: 10,000 requests/hour
- Enterprise: Unlimited

## Error Handling

The API uses standard HTTP status codes:

- 200: Success
- 400: Bad Request
- 401: Unauthorized
- 429: Rate Limit Exceeded
- 500: Server Error
`,
      metadata: {
        title: 'Getting Started Guide',
        category: 'documentation',
        version: '1.0',
      },
    };

    const result = await plugin.ingest([testDoc], { agentId: 'test-agent' });
    
    if (result.success) {
      console.log(`✅ Document ingested: ${result.indexed} document(s)`);
      console.log(`   Strategy: ${result.metadata?.strategy}`);
      console.log(`   Generated chunks: ${result.metadata?.totalChunks || 'N/A'}\n`);
    } else {
      console.log('❌ Error ingesting:', result.errors);
      return;
    }

    // 2. Wait a moment for the index to update
    console.log('⏳ Waiting 2 seconds for indexing...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Run test queries
    const queries = [
      'How do I authenticate?',
      'Show me code examples for POST requests',
      'What are the rate limits?',
    ];

    for (const query of queries) {
      console.log(`🔍 Query: "${query}"`);
      
      const context = await plugin.retrieveContext(query, {
        agentId: 'test-agent',
      });

      console.log(`   Results: ${context.metadata?.count}`);
      console.log(`   Average score: ${context.metadata?.avgScore?.toFixed(3)}`);
      
      if (context.sources && context.sources.length > 0) {
        console.log(`   Top result: ${context.sources[0].metadata?.title || 'N/A'}`);
        console.log(`   Score: ${context.sources[0].score.toFixed(3)}`);
      }
      console.log();
    }

    // 4. Show cache statistics
    const cacheStats = plugin.getCacheStats();
    
    console.log('📊 Embedding cache statistics:');
    console.log(`   Enabled: ${cacheStats.enabled}`);
    console.log(`   Hits: ${cacheStats.hits}`);
    console.log(`   Misses: ${cacheStats.misses}`);
    console.log(`   Cache size: ${cacheStats.size}`);
    console.log(`   Hit rate: ${((cacheStats.hitRate ?? 0) * 100).toFixed(1)}%`);
    
    console.log('\n💡 Generated embeddings breakdown:');
    console.log(`   - Document chunks: ${result.metadata?.totalChunks || 'N/A'}`);
    console.log(`   - Query embeddings: ${queries.length}`);
    console.log(`   - Total: ${cacheStats.misses} new embeddings\n`);

    console.log('✅ Test completed successfully!\n');
    console.log('💡 The document has been persisted in MongoDB');
    console.log('   You can restart and query without re-ingesting\n');

  } catch (error) {
    console.error('❌ Error during test:', error);
    process.exit(1);
  } finally {
    await plugin.disconnect();
  }
}

testDocsRAG();
