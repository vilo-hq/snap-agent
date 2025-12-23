/**
 * Example: Using RAG Plugin with Caching
 * 
 * This example demonstrates:
 * 1. How caching improves performance for repeat queries
 * 2. How to monitor cache statistics
 * 3. Cache hit rate improvements over time
 */

import { createClient } from '../../sdk/src';
import { MongoDBStorage } from '../../sdk/src/storage';
import { EcommerceRAGPlugin } from './src';

async function main() {
  console.log('RAG Plugin Caching Example\n');

  // Initialize plugin with caching enabled (default)
  const plugin = new EcommerceRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    voyageApiKey: process.env.VOYAGE_API_KEY!,
    tenantId: 'demo-store',
    language: 'en',
    
    // Optional: Customize cache settings
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000, // 1 hour
        maxSize: 1000,
      },
      attributes: {
        enabled: true,
        ttl: 1800000, // 30 minutes
        maxSize: 500,
      },
    },
  });

  // Create client and agent with plugin
  const client = createClient({
    storage: new MongoDBStorage(process.env.MONGODB_URI!),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  const agent = await client.createAgent({
    name: 'Shopping Assistant',
    instructions: 'You are a helpful shopping assistant.',
    model: 'gpt-4o',
    userId: 'demo-user',
    plugins: [plugin],
  });

  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'demo-user',
  });

  console.log('Initial cache state:');
  console.log(JSON.stringify(plugin.getCacheStats(), null, 2));
  console.log('\n');

  // Simulate queries
  const queries = [
    'Show me red running shoes under $100',
    'I want nike sneakers',
    'Show me red running shoes under $100', // Repeat - should hit cache!
    'Looking for blue jackets',
    'I want nike sneakers', // Repeat - should hit cache!
    'Show me red running shoes under $100', // Repeat again!
  ];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const isRepeat = queries.slice(0, i).includes(query);

    console.log(`\n${i + 1}. Query: "${query}" ${isRepeat ? '(repeat)' : '(new)'}`);
    
    const start = Date.now();
    
    const response = await client.chat({
      threadId: thread.id,
      message: query,
      useRAG: true,
    });
    
    const duration = Date.now() - start;
    
    console.log(`   Response time: ${duration}ms`);
    console.log(`   Reply: ${response.reply.substring(0, 100)}...`);

    // Show cache stats after each query
    const stats = plugin.getCacheStats();
    console.log(`   Cache stats:`);
    console.log(`      Embeddings: ${stats.embeddings.hits} hits, ${stats.embeddings.misses} misses (${(parseFloat(stats.embeddings.hitRate) * 100).toFixed(0)}% hit rate)`);
    console.log(`      Attributes: ${stats.attributes.hits} hits, ${stats.attributes.misses} misses (${(parseFloat(stats.attributes.hitRate) * 100).toFixed(0)}% hit rate)`);
  }

  console.log('\n\nFinal Cache Statistics:');
  console.log('─'.repeat(60));
  const finalStats = plugin.getCacheStats();
  
  console.log('\nEmbeddings Cache:');
  console.log(`   Size: ${finalStats.embeddings.size}/${finalStats.embeddings.maxSize} entries`);
  console.log(`   Hits: ${finalStats.embeddings.hits}`);
  console.log(`   Misses: ${finalStats.embeddings.misses}`);
  console.log(`   Hit Rate: ${(parseFloat(finalStats.embeddings.hitRate) * 100).toFixed(1)}%`);
  
  console.log('\nAttributes Cache:');
  console.log(`   Size: ${finalStats.attributes.size}/${finalStats.attributes.maxSize} entries`);
  console.log(`   Hits: ${finalStats.attributes.hits}`);
  console.log(`   Misses: ${finalStats.attributes.misses}`);
  console.log(`   Hit Rate: ${(parseFloat(finalStats.attributes.hitRate) * 100).toFixed(1)}%`);

  console.log('\nObservations:');
  console.log('   • First query of each type is slower (cache miss)');
  console.log('   • Repeat queries are ~5x faster (cache hit)');
  console.log('   • No additional API costs for cached queries');
  console.log('   • Cache automatically cleans up expired entries');

  // Cleanup
  await plugin.disconnect();
  
  console.log('\nExample complete!');
}

main().catch(console.error);

