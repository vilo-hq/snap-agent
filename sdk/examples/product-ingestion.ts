/**
 * Product Ingestion Example
 * 
 * Demonstrates how to ingest product data into the RAG e-commerce plugin
 * for use with a shopping assistant agent.
 * 
 * Installing @snap-agent/rag-ecommerce is required for this example.
 * 
 * Features:
 * - Bulk product ingestion with embeddings
 * - Single product updates
 * - Product deletion
 * - Batch operations (insert, update, delete)
 * - Error handling and validation
 * 
 * Prerequisites:
 * - MongoDB Atlas with vector search index configured
 * - Environment variables set (MONGODB_URI, OPENAI_API_KEY, VOYAGE_API_KEY)
 * 
 * Run: ts-node sdk/examples/product-ingestion.ts
 */

import { createClient, MongoDBStorage } from '../src';
// @ts-ignore - Plugin is a peer dependency, install with: npm install @snap-agent/rag-ecommerce
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

async function main() {
  console.log('='.repeat(60));
  console.log('Product Ingestion Example - Luxora Department Store');
  console.log('='.repeat(60));
  console.log();

  // Validate environment variables
  if (!process.env.MONGODB_URI || !process.env.OPENAI_API_KEY || !process.env['VOYAGE_API_KEY']) {
    throw new Error('Missing required environment variables: MONGODB_URI, OPENAI_API_KEY, VOYAGE_API_KEY');
  }

  // Initialize RAG plugin
  const ragPlugin = new EcommerceRAGPlugin({
    mongoUri: process.env.MONGODB_URI,
    dbName: 'luxora_store',
    collection: 'products',
    openaiApiKey: process.env.OPENAI_API_KEY,
    voyageApiKey: process.env['VOYAGE_API_KEY']!,
    embeddingModel: 'voyage-3',
    tenantId: 'luxora-store',
    enableAttributeExtraction: true,
    cache: {
      embeddings: { enabled: true, ttl: 3600000, maxSize: 2000 },
      attributes: { enabled: true, ttl: 1800000, maxSize: 1000 },
    },
  });

  // Initialize SDK
  console.log('Initializing SDK...');
  const client = createClient({
    storage: new MongoDBStorage({
      uri: process.env.MONGODB_URI,
      dbName: 'luxora_store',
    }),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY },
    },
  });

  // Create shopping assistant agent with RAG plugin
  console.log('Creating agent...');
  const agent = await client.createAgent({
    name: 'Luxora Shopping Assistant',
    instructions: 'You are a helpful shopping assistant for Luxora Department Store.',
    model: 'gpt-4o',
    provider: 'openai',
    userId: 'system',
    organizationId: 'luxora-store',
    plugins: [ragPlugin],
  });
  console.log(`Agent created: ${agent.id}`);
  console.log();

  // Example 1: Bulk Product Ingestion
  console.log('Example 1: Bulk Product Ingestion');
  console.log('-'.repeat(60));

  const newProducts = [
    {
      id: 'JKT-001',
      content: 'Modern black leather jacket for men with zipper closure and multiple pockets. Premium quality genuine leather.',
      metadata: {
        title: 'Modern Leather Jacket',
        category: 'Jackets',
        brand: 'UrbanStyle',
        color: 'Black',
        material: 'Genuine Leather',
        size: ['M', 'L', 'XL'],
        gender: 'M',
        price: 299.99,
        inStock: true,
        metrics: {
          popularity: 0.85,
          ctr: 0.12,
          sales: 245,
        },
      },
    },
    {
      id: 'JKT-002',
      content: 'Casual brown leather jacket with modern fit. Soft suede-like finish, perfect for everyday wear.',
      metadata: {
        title: 'Casual Brown Leather Jacket',
        category: 'Jackets',
        brand: 'UrbanStyle',
        color: 'Brown',
        material: 'Suede Leather',
        size: ['S', 'M', 'L', 'XL'],
        gender: 'M',
        price: 279.99,
        inStock: true,
        metrics: {
          popularity: 0.78,
          ctr: 0.09,
          sales: 189,
        },
      },
    },
    {
      id: 'BOOT-001',
      content: 'Black leather chelsea boots for men. Classic style with elastic side panels and pull tab.',
      metadata: {
        title: 'Chelsea Leather Boots',
        category: 'Boots',
        brand: 'ClassicFoot',
        color: 'Black',
        material: 'Genuine Leather',
        size: ['8', '9', '10', '11', '12'],
        gender: 'M',
        price: 189.99,
        inStock: true,
        metrics: {
          popularity: 0.92,
          ctr: 0.15,
          sales: 412,
        },
      },
    },
  ];

  console.log(`Ingesting ${newProducts.length} products...`);
  const ingestResults = await agent.ingestDocuments(newProducts, {
    batchSize: 10,
    overwrite: false,
  });

  ingestResults.forEach((result, idx) => {
    console.log(`\nPlugin ${idx + 1} results:`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Indexed: ${result.indexed}`);
    console.log(`  Failed: ${result.failed}`);
    if (result.errors) {
      console.log(`  Errors:`, result.errors);
    }
  });
  console.log();

  // Example 2: Update Single Product
  console.log('Example 2: Update Product Price and Stock');
  console.log('-'.repeat(60));

  console.log('Updating JKT-001 price to $279.99 and marking as low stock...');
  await agent.updateDocument('JKT-001', {
    metadata: {
      price: 279.99,
      inStock: true,
      metrics: {
        popularity: 0.88,
        sales: 267,
      },
    },
  });
  console.log('Product updated successfully');
  console.log();

  // Example 3: Bulk Operations
  console.log('Example 3: Bulk Operations (Insert, Update, Delete)');
  console.log('-'.repeat(60));

  const bulkOps = [
    {
      type: 'insert' as const,
      id: 'SHOE-001',
      document: {
        id: 'SHOE-001',
        content: 'White leather sneakers with modern design. Comfortable and stylish for casual wear.',
        metadata: {
          title: 'Modern White Sneakers',
          category: 'Shoes',
          brand: 'UrbanKicks',
          color: 'White',
          material: 'Leather',
          size: ['7', '8', '9', '10', '11'],
          gender: 'M',
          price: 129.99,
          inStock: true,
        },
      },
    },
    {
      type: 'update' as const,
      id: 'BOOT-001',
      document: {
        id: 'BOOT-001',
        metadata: {
          price: 179.99,
        },
      },
    },
  ];

  console.log(`Performing ${bulkOps.length} bulk operations...`);
  const bulkResults = await agent.bulkDocumentOperations(bulkOps);

  bulkResults.forEach((result, idx) => {
    console.log(`\nPlugin ${idx + 1} results:`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Inserted: ${result.inserted}`);
    console.log(`  Updated: ${result.updated}`);
    console.log(`  Deleted: ${result.deleted}`);
    console.log(`  Failed: ${result.failed}`);
    if (result.errors) {
      console.log(`  Errors:`, result.errors);
    }
  });
  console.log();

  // Example 4: Test Search After Ingestion
  console.log('Example 4: Test Product Search');
  console.log('-'.repeat(60));

  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'test-user',
    name: 'Product Search Test',
  });

  console.log('Query: "Show me black leather jackets under $300"');
  const response = await client.chat({
    threadId: thread.id,
    message: 'Show me black leather jackets under $300',
    useRAG: true,
  });

  console.log(`\nAssistant: ${response.reply}`);
  console.log();

  if (response.metadata?.['ragMetadata']) {
    const ragData = response.metadata['ragMetadata'][0];
    console.log('RAG Results:');
    console.log(`  Products found: ${ragData.metadata?.productCount || 0}`);

    if (ragData.metadata?.topProducts) {
      console.log('  Top matches:');
      ragData.metadata.topProducts.slice(0, 3).forEach((product: any, idx: number) => {
        console.log(`    ${idx + 1}. ${product.title} - $${product.attributes?.price || 'N/A'}`);
      });
    }
  }
  console.log();

  // Example 5: Delete Products
  console.log('Example 5: Delete Products');
  console.log('-'.repeat(60));

  console.log('Deleting SHOE-001...');
  const deletedCount = await agent.deleteDocuments('SHOE-001');
  console.log(`Deleted ${deletedCount} product(s)`);
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log('Successfully demonstrated:');
  console.log('  1. Bulk product ingestion with embeddings');
  console.log('  2. Single product updates');
  console.log('  3. Bulk operations (insert, update, delete)');
  console.log('  4. RAG-powered product search');
  console.log('  5. Product deletion');
  console.log();
  console.log('Products are now indexed and searchable via the shopping assistant!');
  console.log('='.repeat(60));

  // Cleanup
  await ragPlugin.disconnect();
}

main()
  .then(() => {
    console.log('\nProcess completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nError:', error);
    process.exit(1);
  });

