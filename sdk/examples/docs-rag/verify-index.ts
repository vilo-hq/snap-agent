/**
 * Script to verify that the vector index is created correctly
 * 
 * .env location:
 * sdk/examples/docs-rag/.env
 * 
 * Usage from the monorepo root:
 * cd sdk/examples/docs-rag
 * npx tsx verify-index.ts
 */

import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { resolve } from 'path';

// Load .env from this directory
config({ path: resolve(__dirname, '.env') });

async function verifyIndex() {
  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'my_docs';
  const collection = process.env.MONGODB_COLLECTION || 'docs_content';

  if (!mongoUri) {
    console.error('❌ Error: MONGODB_URI is not configured\n');
    console.log('📁 Create the .env file at: sdk/examples/docs-rag/.env');
    console.log('\n.env example:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('MONGODB_COLLECTION="docs_content"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  console.log('📦 Connecting to MongoDB...');
  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db(dbName);
    const coll = db.collection(collection);

    // Verify that the collection exists
    const collections = await db.listCollections({ name: collection }).toArray();
    
    if (collections.length === 0) {
      console.log(`⚠️  Collection "${collection}" does not exist yet`);
      console.log('   It will be created automatically when you ingest the first document\n');
    } else {
      console.log(`✅ Collection "${collection}" exists`);
      
      // Count documents
      const count = await coll.countDocuments();
      console.log(`   📊 Documentos: ${count}\n`);
    }

    // Try to list search indexes
    console.log('🔍 Verifying vector indexes...');
    
    try {
      // Note: listSearchIndexes() only works on Atlas M10+
      const searchIndexes = await coll.listSearchIndexes().toArray();
      
      if (searchIndexes.length === 0) {
        console.log('❌ No vector index found');
        console.log('\n📘 Steps to create the index:');
        console.log('1. Go to MongoDB Atlas UI');
        console.log('2. Select your cluster → Atlas Search');
        console.log('3. Create Search Index → Atlas Vector Search');
        console.log('4. Name: "docs_vector_index"');
        console.log('5. Paste the JSON configuration from the README\n');
        console.log('See full guide at: plugins/rag/docs/ATLAS_SETUP_GUIDE.md\n');
      } else {
        console.log(`✅ Found ${searchIndexes.length} index(es):\n`);
        
        searchIndexes.forEach((index: any) => {
          console.log(`   📌 Name: ${index.name}`);
          console.log(`   📊 Status: ${index.status || 'N/A'}`);
          console.log(`   🗄️  Type: ${index.type || 'N/A'}`);
          
          if (index.name === 'docs_vector_index') {
            console.log('   ✅ Index "docs_vector_index" found!\n');
          } else {
            console.log('   ⚠️  This is not the expected index\n');
          }
        });
      }
    } catch (error: any) {
      if (error.message?.includes('not supported')) {
        console.log('⚠️  listSearchIndexes() not supported on this Atlas tier');
        console.log('   Requires Atlas M10 or higher for Vector Search');
        console.log('\n   To verify manually:');
        console.log('   1. Go to Atlas UI → Atlas Search');
        console.log('   2. Verify that "docs_vector_index" exists\n');
      } else {
        console.log('⚠️  Error listing indexes:', error.message);
      }
    }

    console.log('\n✅ Verification complete!');

  } catch (error) {
    console.error('❌ Connection error:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

verifyIndex();
