/**
 * Script para verificar que el índice vectorial está creado correctamente
 * 
 * Ubicación del .env:
 * sdk/examples/docs-rag/.env
 * 
 * Uso desde la raíz del monorepo:
 * cd sdk/examples/docs-rag
 * npx tsx verify-index.ts
 */

import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { resolve } from 'path';

// Cargar .env desde este directorio
config({ path: resolve(__dirname, '.env') });

async function verifyIndex() {
  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'my_docs';
  const collection = process.env.MONGODB_COLLECTION || 'docs_content';

  if (!mongoUri) {
    console.error('❌ Error: MONGODB_URI no está configurado\n');
    console.log('📁 Crea el archivo .env en: sdk/examples/docs-rag/.env');
    console.log('\nEjemplo de .env:');
    console.log('MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/"');
    console.log('MONGODB_DB="my_docs"');
    console.log('MONGODB_COLLECTION="docs_content"');
    console.log('OPENAI_API_KEY="sk-proj-xxxxx"\n');
    process.exit(1);
  }

  console.log('📦 Conectando a MongoDB...');
  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log('✅ Conectado a MongoDB\n');

    const db = client.db(dbName);
    const coll = db.collection(collection);

    // Verificar que la colección existe
    const collections = await db.listCollections({ name: collection }).toArray();
    
    if (collections.length === 0) {
      console.log(`⚠️  La colección "${collection}" no existe todavía`);
      console.log('   Se creará automáticamente cuando ingieras el primer documento\n');
    } else {
      console.log(`✅ Colección "${collection}" existe`);
      
      // Contar documentos
      const count = await coll.countDocuments();
      console.log(`   📊 Documentos: ${count}\n`);
    }

    // Intentar listar índices de búsqueda
    console.log('🔍 Verificando índices vectoriales...');
    
    try {
      // Nota: listSearchIndexes() solo funciona en Atlas M10+
      const searchIndexes = await coll.listSearchIndexes().toArray();
      
      if (searchIndexes.length === 0) {
        console.log('❌ No se encontró ningún índice vectorial');
        console.log('\n📘 Pasos para crear el índice:');
        console.log('1. Ve a MongoDB Atlas UI');
        console.log('2. Selecciona tu cluster → Atlas Search');
        console.log('3. Create Search Index → Atlas Vector Search');
        console.log('4. Nombre: "docs_vector_index"');
        console.log('5. Pega la configuración JSON del README\n');
        console.log('Ver guía completa en: plugins/rag/docs/ATLAS_SETUP_GUIDE.md\n');
      } else {
        console.log(`✅ Encontrados ${searchIndexes.length} índice(s):\n`);
        
        searchIndexes.forEach((index: any) => {
          console.log(`   📌 Nombre: ${index.name}`);
          console.log(`   📊 Estado: ${index.status || 'N/A'}`);
          console.log(`   🗄️  Tipo: ${index.type || 'N/A'}`);
          
          if (index.name === 'docs_vector_index') {
            console.log('   ✅ Índice "docs_vector_index" encontrado!\n');
          } else {
            console.log('   ⚠️  Este no es el índice esperado\n');
          }
        });
      }
    } catch (error: any) {
      if (error.message?.includes('not supported')) {
        console.log('⚠️  listSearchIndexes() no soportado en este tier de Atlas');
        console.log('   Requiere Atlas M10 o superior para Vector Search');
        console.log('\n   Para verificar manualmente:');
        console.log('   1. Ve a Atlas UI → Atlas Search');
        console.log('   2. Verifica que existe "docs_vector_index"\n');
      } else {
        console.log('⚠️  Error al listar índices:', error.message);
      }
    }

    console.log('\n✅ Verificación completa!');

  } catch (error) {
    console.error('❌ Error de conexión:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

verifyIndex();
