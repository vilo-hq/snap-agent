/**
 * URL Ingestion Example
 * 
 * This example demonstrates how to ingest documents from various URL sources:
 * - CSV files (S3, Google Drive, etc.)
 * - JSON APIs
 * - Scheduled syncs
 * - Webhook handlers
 */

import { createClient, MongoDBStorage, Models } from '../src';

async function main() {
  // Initialize SDK
  const client = createClient({
    storage: new MongoDBStorage(process.env.MONGODB_URI || 'mongodb://localhost:27017/agents'),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  // Create an agent with RAG plugin
  const agent = await client.createAgent({
    name: 'E-commerce Assistant',
    instructions: 'You are a helpful shopping assistant with access to product information.',
    provider: 'openai',
    model: Models.OpenAI.GPT4O,
    userId: 'demo-user',
    // Note: In production, add your RAG plugin here
    // plugins: [ecommerceRAGPlugin]
  });

  console.log('Agent created:', agent.id);

  // ============================================================================
  // Example 1: Ingest from CSV URL (e.g., S3, Google Drive)
  // ============================================================================
  
  console.log('\nExample 1: Ingesting from CSV URL...');
  
  try {
    const csvResult = await agent.ingestFromUrl({
      url: 'https://mybucket.s3.amazonaws.com/products.csv',
      type: 'csv',
      auth: {
        type: 'custom',
        headers: {
          'x-custom-header': 'value',
        },
      },
      transform: {
        fieldMapping: {
          id: 'product_id',
          content: 'product_name',
          price: 'price',
          inStock: 'stock_quantity',
        },
      },
      metadata: {
        source: 's3',
        category: 'electronics',
      },
    });

    console.log('CSV Ingestion Result:', {
      success: csvResult[0].success,
      indexed: csvResult[0].indexed,
      failed: csvResult[0].failed,
      sourceUrl: csvResult[0].sourceUrl,
    });
  } catch (error) {
    console.error('CSV ingestion failed:', error);
  }

  // ============================================================================
  // Example 2: Ingest from JSON API
  // ============================================================================
  
  console.log('\nExample 2: Ingesting from JSON API...');
  
  try {
    const apiResult = await agent.ingestFromUrl({
      url: 'https://api.mystore.com/products',
      type: 'json',
      auth: {
        type: 'bearer',
        token: process.env.API_TOKEN || 'your-api-token',
      },
      transform: {
        documentPath: '$.products[*]', // JSONPath to extract products array
        fieldMapping: {
          id: 'id',
          content: 'name',
          price: 'price',
          description: 'description',
        },
      },
      timeout: 60000, // 60 seconds
    });

    console.log('API Ingestion Result:', {
      success: apiResult[0].success,
      indexed: apiResult[0].indexed,
      documentsFetched: apiResult[0].documentsFetched,
    });
  } catch (error) {
    console.error('API ingestion failed:', error);
  }

  // ============================================================================
  // Example 3: Shopify Product Feed
  // ============================================================================
  
  console.log('\nExample 3: Ingesting from Shopify...');
  
  try {
    const shopifyResult = await agent.ingestFromUrl({
      url: 'https://mystore.myshopify.com/admin/api/2024-01/products.json',
      type: 'json',
      auth: {
        type: 'api-key',
        header: 'X-Shopify-Access-Token',
        key: process.env.SHOPIFY_TOKEN || 'your-shopify-token',
      },
      transform: {
        documentPath: '$.products[*]',
        fieldMapping: {
          id: 'id',
          content: 'title',
          description: 'body_html',
          price: 'variants[0].price',
          inStock: 'variants[0].inventory_quantity',
        },
      },
    });

    console.log('Shopify Ingestion Result:', {
      success: shopifyResult[0].success,
      indexed: shopifyResult[0].indexed,
    });
  } catch (error) {
    console.error('Shopify ingestion failed:', error);
  }

  // ============================================================================
  // Example 4: With Scheduled Sync (Conceptual - scheduling not yet implemented)
  // ============================================================================
  
  console.log('\nExample 4: Setting up scheduled sync...');
  console.log('Note: Scheduling requires additional infrastructure (cron jobs, etc.)');
  
  // This would require a separate scheduler service
  // const scheduledResult = await agent.ingestFromUrl({
  //   url: 'https://api.mystore.com/products',
  //   type: 'json',
  //   auth: { type: 'bearer', token: process.env.API_TOKEN },
  //   schedule: {
  //     cron: '0 */4 * * *', // Every 4 hours
  //     timezone: 'America/New_York',
  //   },
  // });

  // ============================================================================
  // Example 5: Handle Webhook (Shopify Product Update)
  // ============================================================================
  
  console.log('\nExample 5: Handling webhook payload...');
  
  try {
    // Simulate a Shopify product update webhook
    const webhookPayload = {
      id: 12345,
      title: 'Updated Product Name',
      body_html: 'Updated description',
      variants: [{
        price: '29.99',
        sku: 'PROD-001',
        inventory_quantity: 50,
      }],
      vendor: 'My Brand',
      product_type: 'T-Shirt',
    };

    const webhookResult = await agent.handleWebhook(
      webhookPayload,
      'shopify', // Source identifier
      { overwrite: true } // Options
    );

    console.log('Webhook Result:', {
      success: webhookResult[0].success,
      indexed: webhookResult[0].indexed,
    });
  } catch (error) {
    console.error('Webhook handling failed:', error);
  }

  console.log('\nAll examples completed!');
}

// Run examples
main().catch(console.error);

