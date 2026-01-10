/**
 * Structured Output Example
 * 
 * Demonstrates how to get structured responses from the agent using:
 * - Flexible JSON mode for arbitrary objects (currently the only supported mode)
 * 
 * Note: Object mode with Zod schemas is planned for future releases.
 * 
 * Prerequisites:
 * 1. Copy .env.example to .env
 * 2. Add your OPENAI_API_KEY to .env
 * 
 * Run: tsx sdk/examples/structured-output.ts
 */

import 'dotenv/config';
import { createClient, MemoryStorage, MongoDBStorage, PluginRegistry } from '../src';
import { EcommerceRAGPlugin } from '../../plugins/rag/ecommerce/src/EcommerceRAGPlugin';
import type { EcommerceRAGConfig } from '../../plugins/rag/ecommerce/src/EcommerceRAGPlugin';
import { ConsoleAnalytics } from '../../plugins/analytics/console/src';
import type { ConsoleAnalyticsConfig } from '../../plugins/analytics/console/src';

const AGENT_INSTRUCTIONS = `Eres el asistente de compras de Inside Shops (inside-shops.com), una tienda de moda y estilo de vida en línea.

Tu rol es:
- Ayudar a los clientes a encontrar productos que se ajusten a sus necesidades
- Ofrecer recomendaciones personalizadas de productos según sus preferencias
- Responder preguntas sobre productos, disponibilidad, tallas, colores y materiales
- Sugerir artículos complementarios y combinaciones de outfits
- Ser amable, servicial y conocedor de las tendencias de moda

Directrices:
- Siempre basa tus recomendaciones en la información de productos proporcionada en el contexto
- Si no tienes información sobre un producto específico, dilo honestamente
- Al recomendar productos, menciona detalles clave como precio, tallas disponibles y colores
- Sé conversacional y cercano manteniendo el profesionalismo
- Si la solicitud del cliente no está clara, haz preguntas para aclarar
- Sugiere alternativas cuando el producto exacto no esté disponible

Recuerda: Representas a Inside Shops - sé útil, preciso y crea una excelente experiencia de compra!

IMPORTANTE: Siempre responde en español.
`;

// E-commerce RAG plugin configuration for Inside Shops
const RAG_PLUGIN_CONFIG: EcommerceRAGConfig = {
  mongoUri: process.env.MONGODB_URI!,
  dbName: 'inside-shops-products',
  collection: 'products',
  vectorIndexName: 'vector_index_is_demo',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'inside-shops',

  // Customize attributes for fashion products
  attributeList: ['description', 'category', 'color', 'brand', 'size', 'material', 'gender', 'season', 'price', 'style'],

  // Tune scoring weights for fashion e-commerce
  rescoringWeights: {
    color: 0.20,
    brand: 0.15,
    category: 0.15,
    material: 0.10,
    popularity: 0.10,
    ctr: 0.05,
  },

  // Enable caching for better performance
  cache: {
    embeddings: { enabled: true, ttl: 3600000, maxSize: 2000 },
    attributes: { enabled: true, ttl: 1800000, maxSize: 1000 },
  },

  // Context settings
  contextProductCount: 8,
  language: 'es',
  includeOutOfStock: false,
};

// Create the Plugin Registry - enables plugin persistence across server restarts
function createPluginRegistry() {
  const registry = new PluginRegistry();

  registry.register('@snap-agent/rag-ecommerce', (config) =>
    new EcommerceRAGPlugin(config as EcommerceRAGConfig)
  );

  registry.register('@snap-agent/analytics-console', (config) =>
    new ConsoleAnalytics(config)
  );

  return registry;
}

export async function createShoppingAssistant() {
  // Use MongoDB if URI is provided, otherwise fall back to MemoryStorage for development
  const storage = process.env.MONGODB_URI
    ? new MongoDBStorage({
      uri: process.env.MONGODB_URI,
      dbName: 'inside-shops-products'
    })
    : new MemoryStorage();

  // Create the plugin registry for plugin persistence
  const pluginRegistry = createPluginRegistry();

  const client = createClient({
    storage,
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
    pluginRegistry, // Enable automatic plugin reinstantiation on agent load
  });

  // Create the e-commerce RAG plugin instance
  const ragPlugin = new EcommerceRAGPlugin(RAG_PLUGIN_CONFIG);

  // Create console analytics for debugging - logs RAG results and more
  const consoleAnalytics = new ConsoleAnalytics({
    level: 'verbose',  // Show detailed logs including RAG context
  });

  // Try to find existing agent first, or create a new one
  // This ensures we reuse the same agent ID (important for RAG product matching)
  const existingAgents = await client.listAgents('system');
  const existingAgentData = existingAgents.find(a => a.name === 'Inside Shops Assistant');

  let agent;
  if (existingAgentData) {
    console.log('Found existing agent, loading it...');
    // Load the full agent object
    agent = await client.getAgent(existingAgentData.id);
    // Add plugins since they're not persisted in the database
    agent.addPlugin(ragPlugin);
    agent.addPlugin(consoleAnalytics);
  } else {
    console.log('Creating new agent...');
    agent = await client.createAgent({
      name: 'Inside Shops Assistant',
      instructions: AGENT_INSTRUCTIONS,
      provider: 'openai',
      model: 'gpt-4o',
      userId: 'system',
      plugins: [
        ragPlugin,           // RAG: Product search knowledge
        consoleAnalytics,    // Analytics: Dev-friendly logging (runs last)
      ],
    });
  }

  console.log(`Shopping Assistant created with ID: ${agent.id}`);
  console.log(agent);
  console.log('Plugins registered:', agent.plugins.length);

  // Test RAG directly to verify vector search is working
  console.log('\n=== TESTING RAG PLUGIN DIRECTLY ===');
  try {
    const testContext = await ragPlugin.retrieveContext('winter jacket leather', {
      agentId: agent.id,
    });
    console.log('RAG Context (first 500 chars):', testContext.content?.substring(0, 500) || 'NO CONTENT');
    console.log('Products found:', testContext.metadata?.productCount || 0);
    console.log('Top products:', JSON.stringify(testContext.metadata?.topProducts?.slice(0, 2), null, 2));
  } catch (error) {
    console.error('RAG TEST ERROR:', error);
  }
  console.log('=== END RAG TEST ===\n');

  return { client, agent, ragPlugin };
}

export async function chat(
  client: Awaited<ReturnType<typeof createShoppingAssistant>>['client'],
  agent: Awaited<ReturnType<typeof createShoppingAssistant>>['agent'],
  threadId: string,
  message: string
) {
  // Get the thread and add the user message
  const thread = await client.getThread(threadId);
  await thread.addMessage('user', message);

  // Get conversation context (last 20 messages)
  const messages = await thread.getConversationContext(20);

  // Use agent.generateResponse() directly to ensure plugins are used
  // (client.chat() reloads agent from DB, losing plugins)
  const result = await agent.generateResponse(messages, {
    useRAG: true,
    threadId: thread.id,
    output: {
      mode: 'json',  // Flexible JSON output
    },
  });

  // Save the assistant's response to the thread
  await thread.addMessage('assistant', result.text);

  // Debug: Log response metadata to see if RAG context was included
  console.log('\n=== CHAT RESPONSE DEBUG ===');
  console.log('Has metadata:', !!result.metadata);
  if (result.metadata) {
    console.log('Metadata keys:', Object.keys(result.metadata));
    console.log('RAG metadata:', JSON.stringify(result.metadata, null, 2));
  }
  console.log('=== END CHAT DEBUG ===\n');

  return {
    reply: result.text,
    threadId: thread.id,
    timestamp: new Date(),
    metadata: result.metadata,
  };
}

// Interactive chat demo
async function main() {
  console.log('Inicializando el Asistente de Compras de Inside Shops...\n');

  const { client, agent } = await createShoppingAssistant();

  // Create a conversation thread
  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'demo-user',
    name: 'Sesión de Compras',
  });

  console.log(`Thread created: ${thread.id}`);
  console.log('\n¡El Asistente de Compras está listo! Escribe tus preguntas abajo.\n');
  console.log('Ejemplos de consultas:');
  console.log('  - "Busco un vestido rojo para una fiesta"');
  console.log('  - "Muéstrame zapatillas de running por menos de $100"');
  console.log('  - "¿Qué chaquetas de invierno tienen?"');
  console.log('\nEscribe "salir" para terminar.\n');

  // Interactive chat loop
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question('Tú: ', async (input) => {
      const userInput = input.trim();

      if (userInput.toLowerCase() === 'salir' || userInput.toLowerCase() === 'exit') {
        console.log('\n¡Gracias por comprar en Inside Shops! ¡Hasta pronto!');
        rl.close();
        process.exit(0);
      }

      if (!userInput) {
        askQuestion();
        return;
      }

      try {
        console.log('\nAsistente: Pensando...');
        const response = await chat(client, agent, thread.id, userInput);
        console.log(`\nAsistente: ${response.reply}\n`);
      } catch (error) {
        console.error('Error:', error);
      }

      askQuestion();
    });
  };

  askQuestion();
}

// Run if executed directly
const isMainModule = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMainModule) {
  main().catch(console.error);
}
