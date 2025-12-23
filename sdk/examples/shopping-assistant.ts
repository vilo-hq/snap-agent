/**
 * Shopping Assistant Example with RAG E-commerce Plugin
 * 
 * This example demonstrates building a sophisticated shopping assistant
 * for "Luxora Department Store" - a fantasy multi-category retailer.
 * 
 * Features demonstrated:
 * - Agent creation with e-commerce RAG plugin
 * - Vector search with product recommendations
 * - Attribute-based filtering (color, brand, category, price)
 * - Multi-turn conversations with context
 * - Cache performance monitoring
 * - Error handling and cleanup
 * 
 * Prerequisites:
 * - MongoDB Atlas with vector search enabled
 * - Products collection with embeddings
 * - Environment variables configured
 * - Install plugin: npm install @snap-agent/rag-ecommerce
 * 
 * Run: ts-node sdk/examples/shopping-assistant.ts
 */

import { createClient, MongoDBStorage } from '../src';
// @ts-ignore - Plugin is a peer dependency, install with: npm install @snap-agent/rag-ecommerce
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

async function main() {
  console.log('='.repeat(60));
  console.log('Luxora Department Store - AI Shopping Assistant');
  console.log('='.repeat(60));
  console.log();

  // Validate environment variables
  const requiredEnvVars = {
    MONGODB_URI: process.env.MONGODB_URI,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VOYAGE_API_KEY: process.env['VOYAGE_API_KEY'],
  };

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  // Initialize the RAG plugin for product search
  const ragPlugin = new EcommerceRAGPlugin({
    // Connection
    mongoUri: process.env.MONGODB_URI!,
    dbName: 'luxora_store',
    collection: 'products',

    // AI Services
    openaiApiKey: process.env.OPENAI_API_KEY!,
    voyageApiKey: process.env['VOYAGE_API_KEY']!,
    embeddingModel: 'voyage-3',

    // Store identification
    tenantId: 'luxora-store',

    // Product attributes to extract from queries
    attributeList: [
      'category',
      'brand',
      'color',
      'size',
      'material',
      'style',
      'gender',
      'price',
      'priceMin',
      'priceMax',
    ],
    enableAttributeExtraction: true,

    // Search configuration
    numCandidates: 50,
    limit: 10,
    vectorIndexName: 'product_vector_index',

    // Attribute and metric weights for rescoring
    rescoringWeights: {
      color: 0.15,
      brand: 0.10,
      category: 0.08,
      material: 0.05,
      size: 0.05,
      popularity: 0.10,
      ctr: 0.08,
      sales: 0.12,
    },

    // Enable reranking for higher precision
    enableReranking: true,
    rerankTopK: 5,

    // Context formatting
    contextProductCount: 8,
    language: 'en',
    includeOutOfStock: false,

    // Caching for performance
    cache: {
      embeddings: {
        enabled: true,
        ttl: 3600000, // 1 hour
        maxSize: 2000,
      },
      attributes: {
        enabled: true,
        ttl: 1800000, // 30 minutes
        maxSize: 1000,
      },
    },

    // Plugin priority
    priority: 100,
  });

  // Initialize SDK with MongoDB storage
  console.log('Initializing SDK...');
  const client = createClient({
    storage: new MongoDBStorage({
      uri: process.env.MONGODB_URI!,
      dbName: 'luxora_store',
    }),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });
  console.log('SDK initialized successfully');
  console.log();

  // Create the shopping assistant agent
  console.log('Creating Shopping Assistant agent...');
  const agent = await client.createAgent({
    name: 'Luxora Shopping Assistant',
    description: 'AI-powered shopping assistant for Luxora Department Store',
    instructions: `You are a helpful and knowledgeable shopping assistant for Luxora Department Store, 
a premium multi-category retailer offering clothing, shoes, accessories, home goods, and electronics.

Your responsibilities:
- Help customers find products that match their needs and preferences
- Provide detailed product information including features, pricing, and availability
- Offer personalized recommendations based on style, budget, and occasion
- Answer questions about sizes, materials, colors, and specifications
- Suggest complementary items and complete outfits
- Be friendly, professional, and attentive to customer preferences

When presenting products:
- Highlight key features and benefits
- Mention price and any special offers
- Note availability and popular items
- Suggest alternatives if exact matches aren't available
- Ask clarifying questions when needed

Always prioritize customer satisfaction and help them make informed purchase decisions.`,
    model: 'gpt-4o',
    provider: 'openai',
    userId: 'system',
    organizationId: 'luxora-store',
    plugins: [ragPlugin],
  });

  console.log(`Agent created successfully`);
  console.log(`  ID: ${agent.id}`);
  console.log(`  Name: ${agent.name}`);
  console.log(`  Model: ${agent.model}`);
  console.log(`  Plugins: ${agent.plugins.length} active`);
  console.log();

  // Create a customer session
  console.log('Creating customer shopping session...');
  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'customer-12345',
    name: 'Spring Shopping Session',
    metadata: {
      sessionType: 'shopping',
      customerSegment: 'premium',
      channel: 'web',
    },
  });
  console.log(`Shopping session created: ${thread.id}`);
  console.log();

  // Simulate a multi-turn shopping conversation
  const conversations = [
    {
      query: "I'm looking for a stylish leather jacket for men. Something modern and not too expensive.",
      description: 'Initial broad query',
    },
    {
      query: 'Do you have any in black or dark brown? My budget is around $200-300.',
      description: 'Narrowing with color and price preferences',
    },
    {
      query: "I like the second option. Does it come in size large? And what material is it exactly?",
      description: 'Follow-up about specific product details',
    },
    {
      query: 'Perfect! Can you suggest some boots that would go well with that jacket?',
      description: 'Cross-category recommendation request',
    },
  ];

  console.log('Starting conversation...');
  console.log('-'.repeat(60));
  console.log();

  for (let i = 0; i < conversations.length; i++) {
    const { query, description } = conversations[i]!;

    console.log(`[Query ${i + 1}] ${description}`);
    console.log(`Customer: "${query}"`);
    console.log();

    try {
      const startTime = Date.now();

      // Send message with RAG enabled for product search
      const response = await client.chat({
        threadId: thread.id,
        message: query,
        useRAG: true, // Enable RAG plugin for product search
      });

      const latency = Date.now() - startTime;

      console.log(`Assistant: ${response.reply}`);
      console.log();

      // Display RAG metadata if available
      if (response.metadata?.['ragMetadata'] && response.metadata['ragMetadata'].length > 0) {
        const ragData = response.metadata['ragMetadata'][0];

        console.log('Search Results:');
        console.log(`Products found: ${ragData.metadata?.productCount || 0}`);

        if (ragData.metadata?.extractedAttributes) {
          console.log('    Extracted attributes:', JSON.stringify(ragData.metadata.extractedAttributes));
        }

        if (ragData.metadata?.topProducts) {
          console.log('    Top matches:');
          ragData.metadata.topProducts.slice(0, 3).forEach((product: any, idx: number) => {
            console.log(`${idx + 1}. ${product.title} - $${product.attributes?.price || 'N/A'} (score: ${product.score?.toFixed(3)})`);
          });
        }
      }

      console.log(`  Response time: ${latency}ms`);
      console.log();

    } catch (error) {
      console.error(`Error processing query ${i + 1}:`, error);
      console.log();
    }

    console.log('-'.repeat(60));
    console.log();

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Display cache performance statistics
  console.log('Cache Performance Statistics:');
  console.log('-'.repeat(60));
  const cacheStats = ragPlugin.getCacheStats();

  console.log('Embeddings Cache:');
  console.log(`  Hits: ${cacheStats.embeddings.hits}`);
  console.log(`  Misses: ${cacheStats.embeddings.misses}`);
  console.log(`  Hit Rate: ${(parseFloat(cacheStats.embeddings.hitRate) * 100).toFixed(1)}%`);
  console.log();

  console.log('Attributes Cache:');
  console.log(`  Hits: ${cacheStats.attributes.hits}`);
  console.log(`  Misses: ${cacheStats.attributes.misses}`);
  console.log(`  Hit Rate: ${(parseFloat(cacheStats.attributes.hitRate) * 100).toFixed(1)}%`);
  console.log();

  const totalHits = cacheStats.embeddings.hits + cacheStats.attributes.hits;
  const totalMisses = cacheStats.embeddings.misses + cacheStats.attributes.misses;
  const totalRate = totalHits / (totalHits + totalMisses);

  console.log(`Overall Cache Performance: ${(totalRate * 100).toFixed(1)}% hit rate`);
  console.log(`Cost Savings: ~${((totalRate) * 70).toFixed(0)}% reduction in API costs`);
  console.log();

  // Display conversation summary
  console.log('Session Summary:');
  console.log('-'.repeat(60));
  const messages = await thread.getMessages();
  console.log(`Total messages exchanged: ${messages.length}`);
  console.log(`Conversation length: ${conversations.length}`);

  // List all active threads for this customer
  const customerThreads = await client.listThreads({
    userId: 'customer-12345'
  });
  console.log(`Total shopping sessions for customer: ${customerThreads.length}`);

  // Cleanup
  await ragPlugin.disconnect();
  console.log('MongoDB connection closed');

}

// Execute with proper error handling
main()
  .then(() => {
    console.log('Process completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

