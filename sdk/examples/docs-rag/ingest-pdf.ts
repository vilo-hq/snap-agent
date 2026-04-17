/**
 * Ejemplo: Ingerir documentos PDF en DocsRAGPlugin
 * 
 * Requiere instalar:
 * pnpm add pdf-parse -D @types/pdf-parse
 * 
 * Uso:
 * cd sdk/examples/docs-rag
 * npx tsx ingest-pdf.ts path/to/document.pdf
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import pdf from 'pdf-parse';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src/DocsRAGPlugin';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function ingestPDF(pdfPath: string) {
  console.log('📄 Extrayendo texto de PDF...\n');

  // 1. Leer archivo PDF
  const dataBuffer = readFileSync(pdfPath);
  const pdfData = await pdf(dataBuffer);

  console.log(`📊 Páginas: ${pdfData.numpages}`);
  console.log(`📝 Caracteres: ${pdfData.text.length}\n`);

  // 2. Crear plugin
  const plugin = new DocsRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB || 'my_docs',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    chunkingStrategy: 'paragraph',  // Mejor para PDFs sin markdown
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
    // 3. Ingerir el contenido del PDF
    const filename = pdfPath.split('/').pop() || pdfPath.split('\\').pop() || pdfPath;
    
    console.log('📦 Ingiriendo en MongoDB...');
    const result = await plugin.ingest([
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
    ], { agentId: 'pdf-agent' });

    if (result.success) {
      console.log(`✅ PDF ingerido exitosamente!`);
      console.log(`   Documentos: ${result.indexed}`);
      console.log(`   Estrategia: ${result.metadata?.strategy}\n`);
    }

    // 4. Probar búsqueda
    console.log('🔍 Probando búsqueda...');
    const context = await plugin.retrieveContext(
      'What is this document about?',
      { agentId: 'pdf-agent' }
    );

    console.log(`   Resultados: ${context.metadata?.count}`);
    console.log(`   Score promedio: ${context.metadata?.avgScore?.toFixed(3)}\n`);

    if (context.sources && context.sources.length > 0) {
      console.log('📄 Fragmentos encontrados:');
      context.sources.forEach((source: any, i: number) => {
        console.log(`   ${i + 1}. Score: ${source.score.toFixed(3)}`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await plugin.disconnect();
  }
}

// Ejecutar
const pdfPath = process.argv[2];

if (!pdfPath) {
  console.error('❌ Error: Proporciona la ruta al archivo PDF');
  console.log('\nUso:');
  console.log('  cd sdk/examples/docs-rag');
  console.log('  npx tsx ingest-pdf.ts path/to/document.pdf');
  process.exit(1);
}

ingestPDF(pdfPath).catch(console.error);
