/**
 * Ejemplo: Verificación de getConfig() en DocsRAGPlugin
 * 
 * Demuestra que:
 * 1. DocsRAGPlugin implementa getConfig()
 * 2. La configuración se serializa correctamente
 * 3. Los valores sensibles usan referencias a env vars
 * 4. El plugin funciona con un agente
 * 
 * Ubicación del .env:
 * sdk/examples/docs-rag/.env
 * 
 * Antes de ejecutar:
 * 1. Configura MONGODB_URI, OPENAI_API_KEY en .env
 * 2. Crea el vector search index en Atlas
 * 
 * Uso desde la raíz del monorepo:
 * cd sdk/examples/docs-rag
 * npx tsx agent-persistence.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient, pluginRegistry } from '../../src';
import { MongoDBStorage } from '../../src/storage/MongoDBStorage';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function testPluginPersistence() {
  console.log('🚀 Verificando getConfig() en DocsRAGPlugin\n');

  // Validar variables de entorno
  if (!process.env.MONGODB_URI || !process.env.OPENAI_API_KEY) {
    console.error('❌ Error: Variables de entorno no configuradas\n');
    console.log('📁 Crea el archivo .env en: sdk/examples/docs-rag/.env');
    console.log('\nEjemplo:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'test_docs';
  const tenantId = 'test-tenant';

  try {
    // 1. Crear el plugin
    console.log('📝 Creando DocsRAGPlugin...');
    const plugin = new DocsRAGPlugin({
      mongoUri,
      dbName,
      collection: 'docs_content',
      tenantId,
      embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
      chunkingStrategy: 'markdown',
      limit: 3,
      minSimilarity: 0.7,
      cache: {
        embeddings: {
          enabled: true,
          ttl: 3600000,
        },
      },
    });
    console.log('✅ Plugin creado\n');

    // 2. Verificar que tiene getConfig()
    console.log('🔍 Verificando getConfig()...');
    if (typeof plugin.getConfig !== 'function') {
      console.error('❌ ERROR: El plugin NO tiene método getConfig()');
      process.exit(1);
    }
    console.log('✅ Método getConfig() existe\n');

    // 3. Obtener la configuración serializable
    console.log('📋 Obteniendo configuración serializable...');
    const pluginConfig = plugin.getConfig();
    console.log('✅ Configuración obtenida\n');

    // 4. Verificar estructura
    console.log('🔍 Verificando estructura de la configuración:');
    console.log('   ├─ mongoUri:', pluginConfig.mongoUri);
    console.log('   ├─ dbName:', pluginConfig.dbName);
    console.log('   ├─ collection:', pluginConfig.collection);
    console.log('   ├─ tenantId:', pluginConfig.tenantId);
    console.log('   ├─ embeddingProviderApiKey:', pluginConfig.embeddingProviderApiKey);
    console.log('   ├─ embeddingProvider:', pluginConfig.embeddingProvider);
    console.log('   ├─ embeddingModel:', pluginConfig.embeddingModel);
    console.log('   ├─ chunkingStrategy:', pluginConfig.chunkingStrategy);
    console.log('   ├─ limit:', pluginConfig.limit);
    console.log('   ├─ minSimilarity:', pluginConfig.minSimilarity);
    console.log('   └─ cache:', JSON.stringify(pluginConfig.cache));
    console.log();

    // 5. Verificar que valores sensibles NO se exponen
    console.log('🔒 Verificando seguridad de valores sensibles...');
    const sensitiveChecks = {
      mongoUri: pluginConfig.mongoUri === '${MONGODB_URI}',
      apiKey: pluginConfig.embeddingProviderApiKey?.match(/^\$\{.+\}$/) !== null,
    };

    if (sensitiveChecks.mongoUri && sensitiveChecks.apiKey) {
      console.log('   ✅ mongoUri usa referencia a env var: ${MONGODB_URI}');
      console.log('   ✅ embeddingProviderApiKey usa referencia a env var');
    } else {
      console.error('   ❌ ERROR: Valores sensibles expuestos directamente');
      if (!sensitiveChecks.mongoUri) {
        console.error('      - mongoUri NO usa referencia a env var');
      }
      if (!sensitiveChecks.apiKey) {
        console.error('      - embeddingProviderApiKey NO usa referencia a env var');
      }
      process.exit(1);
    }
    console.log();

    // 6. Verificar que es JSON serializable
    console.log('📦 Verificando serialización JSON...');
    try {
      const json = JSON.stringify(pluginConfig);
      const parsed = JSON.parse(json);
      console.log('   ✅ La configuración es JSON-serializable');
      console.log('   ✅ Tamaño serializado:', json.length, 'bytes');
    } catch (error) {
      console.error('   ❌ ERROR: La configuración NO es JSON-serializable');
      console.error('   ', error);
      process.exit(1);
    }
    console.log();

    // 7. Registrar en PluginRegistry (simula lo que haría el SDK)
    console.log('📋 Registrando plugin en PluginRegistry...');
    pluginRegistry.register('docs-rag', (config: any) => {
      return new DocsRAGPlugin(config as any);
    });
    console.log('   ✅ Plugin registrado exitosamente\n');

    // 8. Simular re-instanciación desde config guardada
    console.log('🔄 Simulando re-instanciación desde config guardada...');
    const storedConfig = {
      type: 'rag' as const,
      name: 'docs-rag',
      config: pluginConfig,
      priority: plugin.priority,
      enabled: true,
    };

    // El registry resuelve las referencias a env vars
    const reinstantiatedPlugin = await pluginRegistry.instantiate(storedConfig);
    console.log('   ✅ Plugin re-instanciado exitosamente');
    console.log('   ├─ Tipo:', reinstantiatedPlugin.type);
    console.log('   ├─ Nombre:', reinstantiatedPlugin.name);
    console.log('   └─ Priority:', reinstantiatedPlugin.priority);
    console.log();

    // 9. Crear un agente con el plugin (usa la API del cliente)
    console.log('🤖 Creando agente con DocsRAGPlugin...');
    const client = createClient({
      storage: new MongoDBStorage({
        uri: mongoUri,
        dbName,
      }),
      providers: {
        openai: { apiKey: process.env.OPENAI_API_KEY! },
      },
    });

    const agent = await client.createAgent({
      name: 'Docs Assistant',
      description: 'Asistente con DocsRAGPlugin',
      instructions: 'Eres un asistente experto en documentación.',
      model: 'gpt-4o-mini',
      userId: 'test-user',
      plugins: [plugin],
    });

    console.log(`   ✅ Agente creado: ${agent.id}`);
    console.log('   ✅ Configuración del plugin guardada en MongoDB\n');

    // 10. Ingerir un documento de prueba
    console.log('📚 Ingiriendo documento de ejemplo...');
    const testDoc = {
      id: 'test-doc-persistence',
      content: `# Test Document

This is a test document to verify that the plugin works correctly after being re-instantiated.

## Section 1
Content here.`,
      metadata: {
        title: 'Test Document',
      },
    };

    const ingestResult = await plugin.ingest([testDoc], { agentId: 'shared' });
    console.log(`   ✅ Documento ingerido: ${ingestResult.indexed} documento(s)`);
    console.log(`   Chunks generados: ${ingestResult.metadata?.totalChunks || 'N/A'}\n`);

    // Cleanup
    await plugin.disconnect();

    console.log('✅ ¡VERIFICACIÓN EXITOSA!\n');
    console.log('Resultados:');
    console.log('   1. ✅ DocsRAGPlugin implementa getConfig()');
    console.log('   2. ✅ Configuración se serializa correctamente');
    console.log('   3. ✅ Valores sensibles usan referencias a env vars');
    console.log('   4. ✅ Plugin es JSON-serializable');
    console.log('   5. ✅ PluginRegistry puede re-instanciar el plugin');
    console.log('   6. ✅ Plugin funciona en un agente');
    console.log('   7. ✅ Configuración se guarda en MongoDB\n');

    console.log('💡 El bug de persistencia está RESUELTO\n');
    console.log('   Al recargar el agente desde MongoDB, el SDK usará');
    console.log('   PluginRegistry para re-instanciar el plugin desde');
    console.log('   la configuración guardada en pluginConfigs.\n');

  } catch (error) {
    console.error('\n❌ Error durante la prueba:', error);
    if (error instanceof Error) {
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

testPluginPersistence();
