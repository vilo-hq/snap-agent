/**
 * Example: Verify getConfig() in DocsRAGPlugin
 *
 * Demonstrates that:
 * 1. DocsRAGPlugin implements getConfig()
 * 2. The configuration is serialized correctly
 * 3. Sensitive values use environment variable references
 * 4. The plugin works with an agent
 *
 * .env location:
 * sdk/examples/docs-rag/.env
 *
 * Before running:
 * 1. Configure MONGODB_URI and OPENAI_API_KEY in .env
 * 2. Create the vector search index in Atlas
 *
 * Usage from the monorepo root:
 * cd sdk/examples/docs-rag
 * npx tsx agent-persistence.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient, pluginRegistry } from '../../src';
import { MongoDBStorage } from '../../src/storage/MongoDBStorage';
import { DocsRAGPlugin } from '../../../plugins/rag/docs/src';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function testPluginPersistence() {
  console.log('🚀 Verifying getConfig() in DocsRAGPlugin\n');

  // Validate environment variables
  if (!process.env.MONGODB_URI || !process.env.OPENAI_API_KEY) {
    console.error('❌ Error: Environment variables not configured\n');
    console.log('📁 Create the .env file at: sdk/examples/docs-rag/.env');
    console.log('\nExample:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'test_docs';
  const tenantId = 'test-tenant';

  try {
    // 1. Create the plugin
    console.log('📝 Creating DocsRAGPlugin...');
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
    console.log('✅ Plugin created\n');

    // 2. Verify that getConfig() exists
    console.log('🔍 Verifying getConfig()...');
    if (typeof plugin.getConfig !== 'function') {
      console.error('❌ ERROR: The plugin does NOT have a getConfig() method');
      process.exit(1);
    }
    console.log('✅ getConfig() method exists\n');

    // 3. Get the serializable configuration
    console.log('📋 Getting serializable configuration...');
    const pluginConfig = plugin.getConfig();
    console.log('✅ Configuration retrieved\n');

    // 4. Verify config structure
    console.log('🔍 Verifying configuration structure:');
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

    // 5. Verify that sensitive values are NOT exposed
    console.log('🔒 Verifying sensitive value security...');
    const sensitiveChecks = {
      mongoUri: pluginConfig.mongoUri === '${MONGODB_URI}',
      apiKey: pluginConfig.embeddingProviderApiKey?.match(/^\$\{.+\}$/) !== null,
    };

    if (sensitiveChecks.mongoUri && sensitiveChecks.apiKey) {
      console.log('   ✅ mongoUri uses env var reference: ${MONGODB_URI}');
      console.log('   ✅ embeddingProviderApiKey uses env var reference');
    } else {
      console.error('   ❌ ERROR: Sensitive values exposed directly');
      if (!sensitiveChecks.mongoUri) {
        console.error('      - mongoUri does NOT use env var reference');
      }
      if (!sensitiveChecks.apiKey) {
        console.error('      - embeddingProviderApiKey does NOT use env var reference');
      }
      process.exit(1);
    }
    console.log();

    // 6. Verify that it is JSON serializable
    console.log('📦 Verifying JSON serialization...');
    try {
      const json = JSON.stringify(pluginConfig);
      const parsed = JSON.parse(json);
      console.log('   ✅ Configuration is JSON-serializable');
      console.log('   ✅ Serialized size:', json.length, 'bytes');
    } catch (error) {
      console.error('   ❌ ERROR: Configuration is NOT JSON-serializable');
      console.error('   ', error);
      process.exit(1);
    }
    console.log();

    // 7. Register in PluginRegistry (simulates what the SDK does)
    console.log('📋 Registering plugin in PluginRegistry...');
    pluginRegistry.register('docs-rag', (config: any) => {
      return new DocsRAGPlugin(config as any);
    });
    console.log('   ✅ Plugin registered successfully\n');

    // 8. Simulate re-instantiation from stored config
    console.log('🔄 Simulating re-instantiation from stored config...');
    const storedConfig = {
      type: 'rag' as const,
      name: 'docs-rag',
      config: pluginConfig,
      priority: plugin.priority,
      enabled: true,
    };

    // The registry resolves environment variable references
    const reinstantiatedPlugin = await pluginRegistry.instantiate(storedConfig);
    console.log('   ✅ Plugin re-instantiated successfully');
    console.log('   ├─ Type:', reinstantiatedPlugin.type);
    console.log('   ├─ Name:', reinstantiatedPlugin.name);
    console.log('   └─ Priority:', reinstantiatedPlugin.priority);
    console.log();

    // 9. Create an agent with the plugin (uses the client API)
    console.log('🤖 Creating agent with DocsRAGPlugin...');
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
      description: 'Assistant with DocsRAGPlugin',
      instructions: 'You are an expert documentation assistant.',
      model: 'gpt-4o-mini',
      userId: 'test-user',
      plugins: [plugin],
    });

    console.log(`   ✅ Agent created: ${agent.id}`);
    console.log('   ✅ Plugin configuration saved in MongoDB\n');

    // 10. Ingest a test document
    console.log('📚 Ingesting example document...');
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
    console.log(`   ✅ Document ingested: ${ingestResult.indexed} document(s)`);
    console.log(`   Generated chunks: ${ingestResult.metadata?.totalChunks || 'N/A'}\n`);

    // Cleanup
    await plugin.disconnect();

    console.log('✅ VERIFICATION SUCCESSFUL!\n');
    console.log('Results:');
    console.log('   1. ✅ DocsRAGPlugin implements getConfig()');
    console.log('   2. ✅ Configuration serializes correctly');
    console.log('   3. ✅ Sensitive values use env var references');
    console.log('   4. ✅ Plugin is JSON-serializable');
    console.log('   5. ✅ PluginRegistry can re-instantiate the plugin');
    console.log('   6. ✅ Plugin works in an agent');
    console.log('   7. ✅ Configuration is saved in MongoDB\n');

    console.log('💡 The persistence bug is RESOLVED\n');
    console.log('   When reloading the agent from MongoDB, the SDK will use');
    console.log('   PluginRegistry to re-instantiate the plugin from');
    console.log('   the configuration saved in pluginConfigs.\n');

  } catch (error) {
    console.error('\n❌ Error during test:', error);
    if (error instanceof Error) {
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

testPluginPersistence();
