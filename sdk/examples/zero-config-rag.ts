/**
 * Zero-Config RAG Example
 * 
 * This example demonstrates how to use the built-in RAG functionality
 * without needing to configure a custom plugin.
 * 
 * Features:
 * - Automatic DefaultRAGPlugin instantiation
 * - Simple document ingestion
 * - Semantic search with embeddings
 * - No external dependencies required
 */

import { createClient, MemoryStorage, Models } from '../src';

async function main() {
  console.log('Zero-Config RAG Example\n');

  // ============================================================================
  // Step 1: Create Client (same as always)
  // ============================================================================

  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  console.log('Client created!\n');

  // ============================================================================
  // Step 2: Create Agent with Zero-Config RAG
  // ============================================================================

  // Just add rag: { enabled: true } - that's it!
  const agent = await client.createAgent({
    name: 'Knowledge Assistant',
    instructions: 'You are a helpful assistant with access to a knowledge base. Use the context provided to answer questions accurately.',
    model: Models.OpenAI.GPT4O_MINI,
    userId: 'demo-user',
    // Zero-config RAG - no plugin instance needed!
    rag: {
      enabled: true,
      // Optional: Override defaults
      // embeddingModel: 'text-embedding-3-large',
      // limit: 10,
    }
  });

  console.log('Agent created with RAG enabled\n');

  // ============================================================================
  // Step 3: Ingest Some Documents
  // ============================================================================

  console.log('Ingesting documents...\n');

  const documents = [
    {
      id: 'doc-1',
      content: 'SnapAgent is a TypeScript-first SDK for building stateful AI agents with multi-provider support. It supports OpenAI, Anthropic, and Google Gemini.',
      metadata: {
        title: 'About SnapAgent',
        category: 'product',
      }
    },
    {
      id: 'doc-2',
      content: 'The DefaultRAGPlugin provides zero-config RAG functionality with in-memory vector storage, OpenAI embeddings, and cosine similarity search.',
      metadata: {
        title: 'DefaultRAGPlugin Features',
        category: 'technical',
      }
    },
    {
      id: 'doc-3',
      content: 'SnapAgent differentiates from LangChain by having only 1 dependency (zod), being TypeScript-first, and providing a cleaner, more intuitive API.',
      metadata: {
        title: 'SnapAgent vs LangChain',
        category: 'comparison',
      }
    },
    {
      id: 'doc-4',
      content: 'You can enable RAG by simply adding rag: { enabled: true } to your agent config. No plugin instance required!',
      metadata: {
        title: 'Zero-Config RAG',
        category: 'tutorial',
      }
    },
  ];

  const result = await agent.ingestDocuments(documents);
  console.log('Ingestion complete:', result[0]);
  console.log('');

  // ============================================================================
  // Step 4: Create a Thread
  // ============================================================================

  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'demo-user',
    name: 'RAG Demo Conversation',
  });

  console.log('Thread created\n');

  // ============================================================================
  // Step 5: Chat with RAG-Enabled Agent
  // ============================================================================

  console.log('Chatting with RAG-enabled agent...\n');

  // Question 1
  console.log('User: What is SnapAgent?\n');
  const response1 = await client.chat({
    threadId: thread.id,
    message: 'What is SnapAgent?',
    useRAG: true, // Enable RAG for this message
  });
  console.log('Assistant:', response1.reply);
  console.log('Metadata:', JSON.stringify(response1.metadata, null, 2));
  console.log('');

  // Question 2
  console.log('User: How does it compare to LangChain?\n');
  const response2 = await client.chat({
    threadId: thread.id,
    message: 'How does it compare to LangChain?',
    useRAG: true,
  });
  console.log('Assistant:', response2.reply);
  console.log('');

  // Question 3
  console.log('User: How do I enable RAG?\n');
  const response3 = await client.chat({
    threadId: thread.id,
    message: 'How do I enable RAG?',
    useRAG: true,
  });
  console.log('Assistant:', response3.reply);
  console.log('');

  // ============================================================================
  // Step 6: Update a Document
  // ============================================================================

  console.log('Updating a document...\n');

  await agent.updateDocument('doc-1', {
    content: 'SnapAgent is a lightweight, TypeScript-first SDK for building stateful AI agents with multi-provider support. It has only 1 dependency and provides zero-config RAG.',
  });

  console.log('Document updated\n');

  // ============================================================================
  // Step 7: Query Again to See Updated Content
  // ============================================================================

  console.log('User: Tell me about SnapAgent again\n');
  const response4 = await client.chat({
    threadId: thread.id,
    message: 'Tell me about SnapAgent again',
    useRAG: true,
  });
  console.log('Assistant:', response4.reply);
  console.log('');

  // ============================================================================
  // Optional: Advanced Configuration
  // ============================================================================

  console.log('You can also configure RAG settings:\n');

  const advancedAgent = await client.createAgent({
    name: 'Advanced RAG Agent',
    instructions: 'You are a helpful assistant.',
    model: Models.OpenAI.GPT4O_MINI,
    userId: 'demo-user',
    rag: {
      enabled: true,
      embeddingModel: 'text-embedding-3-large', // Use larger model
      limit: 10, // Return more results
      // Or provide a different API key
      // embeddingProviderApiKey: process.env.CUSTOM_API_KEY,
    }
  });

  console.log('Advanced agent created with custom RAG config\n');

  // ============================================================================
  // Stats
  // ============================================================================

  console.log('Summary:');
  console.log('- Documents ingested: 4');
  console.log('- Documents updated: 1');
  console.log('- Conversations: 4');
  console.log('- RAG-enabled queries: 4');
  console.log('');
  console.log('All done! Zero-config RAG is that easy.');
}

// Run the example
main().catch(console.error);

