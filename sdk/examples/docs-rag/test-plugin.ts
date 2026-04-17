/**
 * Script de ejemplo para probar DocsRAGPlugin con MongoDB
 * 
 * Ubicación del .env:
 * sdk/examples/docs-rag/.env
 * 
 * Antes de ejecutar:
 * 1. Instala dependencias: pnpm install (en la raíz del monorepo)
 * 2. Crea el archivo .env en sdk/examples/docs-rag/
 * 3. Configura MONGODB_URI y OPENAI_API_KEY
 * 4. Crea el vector search index en Atlas
 * 
 * Uso desde la raíz del monorepo:
 * cd sdk/examples/docs-rag
 * npx tsx test-plugin.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function testDocsRAG() {
  console.log('🚀 Probando DocsRAGPlugin con MongoDB\n');

  // Validar variables de entorno
  if (!process.env.MONGODB_URI) {
    console.error('❌ Error: MONGODB_URI no está configurado\n');
    console.log('📁 Crea el archivo .env en: sdk/examples/docs-rag/.env');
    console.log('\nEjemplo:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY no está configurado\n');
    console.log('📁 Crea el archivo .env en: sdk/examples/docs-rag/.env');
    process.exit(1);
  }

  // Crear plugin
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
    // 1. Ingerir documento de ejemplo
    console.log('📝 Ingiriendo documento de ejemplo...');
    
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
      console.log(`✅ Documento ingerido: ${result.indexed} documento(s)`);
      console.log(`   Estrategia: ${result.metadata?.strategy}`);
      console.log(`   Chunks generados: ${result.metadata?.totalChunks || 'N/A'}\n`);
    } else {
      console.log('❌ Error al ingerir:', result.errors);
      return;
    }

    // 2. Esperar un momento para que el índice se actualice
    console.log('⏳ Esperando 2 segundos para indexación...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Hacer búsquedas de prueba
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

      console.log(`   Resultados: ${context.metadata?.count}`);
      console.log(`   Score promedio: ${context.metadata?.avgScore?.toFixed(3)}`);
      
      if (context.sources && context.sources.length > 0) {
        console.log(`   Top resultado: ${context.sources[0].metadata?.title || 'N/A'}`);
        console.log(`   Score: ${context.sources[0].score.toFixed(3)}`);
      }
      console.log();
    }

    // 4. Mostrar estadísticas de caché
    const cacheStats = plugin.getCacheStats();
    
    console.log('📊 Estadísticas de caché de embeddings:');
    console.log(`   Enabled: ${cacheStats.enabled}`);
    console.log(`   Hits: ${cacheStats.hits}`);
    console.log(`   Misses: ${cacheStats.misses}`);
    console.log(`   Cache size: ${cacheStats.size}`);
    console.log(`   Hit rate: ${((cacheStats.hitRate ?? 0) * 100).toFixed(1)}%`);
    
    console.log('\n💡 Breakdown de embeddings generados:');
    console.log(`   - Chunks del documento: ${result.metadata?.totalChunks || 'N/A'}`);
    console.log(`   - Embeddings de queries: ${queries.length}`);
    console.log(`   - Total: ${cacheStats.misses} embeddings nuevos\n`);

    console.log('✅ Prueba completada exitosamente!\n');
    console.log('💡 El documento quedó persistido en MongoDB');
    console.log('   Puedes reiniciar y hacer queries sin re-ingerir\n');

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
    process.exit(1);
  } finally {
    await plugin.disconnect();
  }
}

testDocsRAG();
