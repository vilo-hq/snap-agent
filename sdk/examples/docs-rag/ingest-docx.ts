/**
 * Ejemplo: Ingerir documentos DOCX en DocsRAGPlugin
 * 
 * Requiere instalar:
 * pnpm add mammoth
 * 
 * Uso:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-docx.ts path/to/document.docx
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import mammoth from 'mammoth';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function ingestDocx(docxPath: string) {
  console.log('📄 Extrayendo texto de DOCX...\n');

  // 1. Leer archivo DOCX
  // extractRawText - solo texto plano
  // convertToMarkdown - convierte a Markdown (preserva formato)
  const result = await mammoth.convertToMarkdown({ path: docxPath });
  
  console.log(`📝 Caracteres: ${result.value.length}`);
  if (result.messages.length > 0) {
    console.log(`⚠️  Advertencias: ${result.messages.length}\n`);
  }

  // 2. Crear plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'markdown',  // Usar markdown si convertimos con mammoth
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
    // 3. Ingerir el contenido del DOCX
    const filename = docxPath.split('/').pop() || docxPath.split('\\').pop() || docxPath;
    
    console.log('📦 Ingiriendo en MongoDB...');
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
      console.log(`✅ DOCX ingerido exitosamente!`);
      console.log(`   Documentos: ${ingestResult.indexed}`);
      console.log(`   Estrategia: ${ingestResult.metadata?.strategy}\n`);
    }

    // 4. Probar búsqueda
    console.log('🔍 Probando búsqueda...');
    const context = await plugin.retrieveContext(
      'What is this document about?',
      { agentId: 'docx-agent' }
    );

    console.log(`   Resultados: ${context.metadata?.count}`);
    console.log(`   Score promedio: ${context.metadata?.avgScore?.toFixed(3)}\n`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const docxPath = process.argv[2];

if (!docxPath) {
  console.error('❌ Error: Proporciona la ruta al archivo DOCX');
  console.log('\nUso:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-docx.ts path/to/document.docx');
  process.exit(1);
}

ingestDocx(docxPath).catch(console.error);
