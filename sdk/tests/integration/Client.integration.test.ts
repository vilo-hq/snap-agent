/**
 * Integration Tests for AgentClient
 *
 * These tests use REAL APIs (OpenAI, MongoDB) and cost money to run.
 * They are skipped if the required environment variables are not set.
 *
 * Required environment variables:
 *   - OPENAI_API_KEY: Your OpenAI API key
 *   - MONGODB_URI: MongoDB connection string (optional, uses MemoryStorage if not set)
 *
 * Run with: npm run test:integration
 */
import dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentClient } from '../../src/core/Client';
import { MemoryStorage } from '../../src/storage/MemoryStorage';
import type { StorageAdapter, AgentData, ThreadData } from '../../src/types';

dotenv.config();
// Check for required environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const hasOpenAI = !!OPENAI_API_KEY;
const hasMongoDB = !!MONGODB_URI;

// Dynamic import for MongoDB (optional dependency)
async function createMongoStorage(uri: string) {
  try {
    const { MongoDBStorage } = await import('../../src/storage/MongoDBStorage');
    return new MongoDBStorage({
      uri,
      dbName: 'snapagent_integration_tests',
      agentsCollection: 'test_agents',
      threadsCollection: 'test_threads',
    });
  } catch {
    console.log('MongoDB not installed, using MemoryStorage');
    return null;
  }
}

// Test configuration
const TEST_USER_ID = 'integration-test-user';
const TEST_ORG_ID = 'integration-test-org';

describe('AgentClient Integration Tests', () => {
  // Track created resources for cleanup
  let createdAgentIds: string[] = [];
  let createdThreadIds: string[] = [];

  let storage: StorageAdapter;
  let client: AgentClient;

  beforeAll(async () => {
    if (!hasOpenAI) {
      console.log('OPENAI_API_KEY not found - Integration tests will be skipped');
      return;
    }

    // Use MongoDB if available, otherwise default to MemoryStorage
    if (hasMongoDB) {
      const mongoStorage = await createMongoStorage(MONGODB_URI!);
      if (mongoStorage) {
        console.log('Using MongoDB storage');
        storage = mongoStorage;
      } else {
        console.log('Using MemoryStorage (MongoDB import failed)');
        storage = new MemoryStorage();
      }
    } else {
      console.log('Using MemoryStorage (MONGODB_URI not set)');
      storage = new MemoryStorage();
    }

    client = new AgentClient({
      storage,
      providers: {
        openai: { apiKey: OPENAI_API_KEY! },
      },
    });
  });

  afterAll(async () => {
    // Cleanup: Delete all created resources
    console.log(`\nCleaning up ${createdAgentIds.length} agents and ${createdThreadIds.length} threads...`);

    for (const threadId of createdThreadIds) {
      try {
        await storage?.deleteThread(threadId);
      } catch {
        // Ignore cleanup errors
      }
    }

    for (const agentId of createdAgentIds) {
      try {
        await storage?.deleteAgent(agentId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Disconnect MongoDB if used
    if (storage && 'disconnect' in storage) {
      await (storage as any).disconnect();
    }
  });

  // Helper to track created resources
  const trackAgent = (agent: { id: string }) => {
    createdAgentIds.push(agent.id);
    return agent;
  };

  const trackThread = (thread: { id: string }) => {
    createdThreadIds.push(thread.id);
    return thread;
  };

  // ============================================================================
  // Agent Creation & Management
  // ============================================================================

  describe('Agent Operations', () => {
    it.skipIf(!hasOpenAI)('should create an agent with OpenAI provider', async () => {
      const agent = await client.createAgent({
        name: 'Integration Test Agent',
        instructions: 'You are a helpful test assistant. Keep responses very brief.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });

      trackAgent(agent);

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('Integration Test Agent');
      expect(agent.provider).toBe('openai');
      expect(agent.model).toBe('gpt-4o-mini');
    });

    it.skipIf(!hasOpenAI)('should retrieve an existing agent', async () => {
      // Create agent first
      const created = await client.createAgent({
        name: 'Retrievable Agent',
        instructions: 'Test agent for retrieval.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      trackAgent(created);

      // Retrieve it
      const retrieved = await client.getAgent(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.name).toBe('Retrievable Agent');
    });

    it.skipIf(!hasOpenAI)('should list agents for a user', async () => {
      // Create two agents
      const agent1 = await client.createAgent({
        name: 'List Test Agent 1',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
      });
      trackAgent(agent1);

      const agent2 = await client.createAgent({
        name: 'List Test Agent 2',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
      });
      trackAgent(agent2);

      // List agents
      const agents = await client.listAgents(TEST_USER_ID, TEST_ORG_ID);

      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents.some((a: AgentData) => a.id === agent1.id)).toBe(true);
      expect(agents.some((a: AgentData) => a.id === agent2.id)).toBe(true);
    });

    it.skipIf(!hasOpenAI)('should update an agent', async () => {
      const agent = await client.createAgent({
        name: 'Update Test Agent',
        instructions: 'Original instructions.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      trackAgent(agent);

      // Update the agent
      await agent.update({
        name: 'Updated Agent Name',
        instructions: 'New instructions.',
      });

      // Verify update
      const updated = await client.getAgent(agent.id);
      expect(updated.name).toBe('Updated Agent Name');
      expect(updated.instructions).toBe('New instructions.');
    });
  });

  // ============================================================================
  // Thread Operations
  // ============================================================================

  describe('Thread Operations', () => {
    let testAgent: Awaited<ReturnType<typeof client.createAgent>>;

    beforeAll(async () => {
      if (!hasOpenAI) return;

      testAgent = await client.createAgent({
        name: 'Thread Test Agent',
        instructions: 'You are a test assistant.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      trackAgent(testAgent);
    });

    it.skipIf(!hasOpenAI)('should create a thread', async () => {
      const thread = await client.createThread({
        agentId: testAgent.id,
        userId: TEST_USER_ID,
        name: 'Test Conversation',
      });
      trackThread(thread);

      expect(thread.id).toBeDefined();
      expect(thread.agentId).toBe(testAgent.id);
      expect(thread.name).toBe('Test Conversation');
    });

    it.skipIf(!hasOpenAI)('should retrieve an existing thread', async () => {
      const created = await client.createThread({
        agentId: testAgent.id,
        userId: TEST_USER_ID,
      });
      trackThread(created);

      const retrieved = await client.getThread(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.agentId).toBe(testAgent.id);
    });

    it.skipIf(!hasOpenAI)('should list threads for an agent', async () => {
      const thread1 = await client.createThread({
        agentId: testAgent.id,
        userId: TEST_USER_ID,
      });
      trackThread(thread1);

      const thread2 = await client.createThread({
        agentId: testAgent.id,
        userId: TEST_USER_ID,
      });
      trackThread(thread2);

      const threads = await client.listThreads({ agentId: testAgent.id });

      expect(threads.length).toBeGreaterThanOrEqual(2);
      expect(threads.some((t: ThreadData) => t.id === thread1.id)).toBe(true);
      expect(threads.some((t: ThreadData) => t.id === thread2.id)).toBe(true);
    });
  });

  // ============================================================================
  // Chat Operations (Real LLM Calls)
  // ============================================================================

  describe('Chat Operations', () => {
    let chatAgent: Awaited<ReturnType<typeof client.createAgent>>;
    let chatThread: Awaited<ReturnType<typeof client.createThread>>;

    beforeAll(async () => {
      if (!hasOpenAI) return;

      chatAgent = await client.createAgent({
        name: 'Chat Test Agent',
        instructions: 'You are a helpful assistant. Keep all responses under 20 words.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      trackAgent(chatAgent);

      chatThread = await client.createThread({
        agentId: chatAgent.id,
        userId: TEST_USER_ID,
      });
      trackThread(chatThread);
    });

    it.skipIf(!hasOpenAI)(
      'should send a message and receive a response',
      async () => {
        const response = await client.chat({
          threadId: chatThread.id,
          message: 'Say "Hello, integration test!" and nothing else.',
        });

        expect(response.reply).toBeDefined();
        expect(response.reply.length).toBeGreaterThan(0);
        expect(response.messageId).toBeDefined();
        expect(response.threadId).toBe(chatThread.id);
        expect(response.timestamp).toBeInstanceOf(Date);

        console.log(`  Response: "${response.reply.substring(0, 100)}..."`);
      },
      { timeout: 30000 }
    );

    it.skipIf(!hasOpenAI)(
      'should maintain conversation context',
      async () => {
        // Create a fresh thread for this test
        const contextThread = await client.createThread({
          agentId: chatAgent.id,
          userId: TEST_USER_ID,
        });
        trackThread(contextThread);

        // First message - set context
        await client.chat({
          threadId: contextThread.id,
          message: 'My favorite color is blue. Remember this.',
        });

        // Second message - test context
        const response = await client.chat({
          threadId: contextThread.id,
          message: 'What is my favorite color?',
        });

        expect(response.reply.toLowerCase()).toContain('blue');
        console.log(`  Context test: "${response.reply}"`);
      },
      { timeout: 30000 }
    );

    it.skipIf(!hasOpenAI)(
      'should persist messages in thread',
      async () => {
        const persistThread = await client.createThread({
          agentId: chatAgent.id,
          userId: TEST_USER_ID,
        });
        trackThread(persistThread);

        // Send a message
        await client.chat({
          threadId: persistThread.id,
          message: 'This is a test message for persistence.',
        });

        // Retrieve messages
        const thread = await client.getThread(persistThread.id);
        const messages = thread.messages;

        expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
        expect(messages[0].role).toBe('user');
        expect(messages[0].content).toContain('test message for persistence');
        expect(messages[1].role).toBe('assistant');
      },
      { timeout: 30000 }
    );
  });

  // ============================================================================
  // Streaming Operations
  // ============================================================================

  describe('Streaming Operations', () => {
    let streamAgent: Awaited<ReturnType<typeof client.createAgent>>;
    let streamThread: Awaited<ReturnType<typeof client.createThread>>;

    beforeAll(async () => {
      if (!hasOpenAI) return;

      streamAgent = await client.createAgent({
        name: 'Stream Test Agent',
        instructions: 'You are a helpful assistant. Keep responses brief.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      trackAgent(streamAgent);

      streamThread = await client.createThread({
        agentId: streamAgent.id,
        userId: TEST_USER_ID,
      });
      trackThread(streamThread);
    });

    it.skipIf(!hasOpenAI)(
      'should stream a response',
      async () => {
        const chunks: string[] = [];
        let fullResponse = '';
        let completed = false;

        await new Promise<void>((resolve, reject) => {
          client.chatStream(
            {
              threadId: streamThread.id,
              message: 'Count from 1 to 5.',
            },
            {
              onChunk: (chunk) => {
                chunks.push(chunk);
              },
              onComplete: (response) => {
                fullResponse = response;
                completed = true;
                resolve();
              },
              onError: (error) => {
                reject(error);
              },
            }
          );
        });

        expect(completed).toBe(true);
        expect(chunks.length).toBeGreaterThan(0);
        expect(fullResponse.length).toBeGreaterThan(0);
        expect(fullResponse).toBe(chunks.join(''));

        console.log(`  Streamed ${chunks.length} chunks, total: ${fullResponse.length} chars`);
      },
      { timeout: 30000 }
    );
  });

  // ============================================================================
  // RAG Operations (Zero-Config)
  // ============================================================================

  describe('RAG Operations', () => {
    it.skipIf(!hasOpenAI)(
      'should create agent with zero-config RAG',
      async () => {
        const ragAgent = await client.createAgent({
          name: 'RAG Test Agent',
          instructions: 'Answer questions using the provided context.',
          provider: 'openai',
          model: 'gpt-4o-mini',
          userId: TEST_USER_ID,
          rag: { enabled: true },
        });
        trackAgent(ragAgent);

        expect(ragAgent.id).toBeDefined();
        expect(ragAgent.plugins.some((p) => p.type === 'rag')).toBe(true);
      }
    );

    it.skipIf(!hasOpenAI)(
      'should ingest documents and query with RAG',
      async () => {
        const ragAgent = await client.createAgent({
          name: 'RAG Query Agent',
          instructions: 'Answer questions using ONLY the provided context. If the answer is not in the context, say "I don\'t know".',
          provider: 'openai',
          model: 'gpt-4o-mini',
          userId: TEST_USER_ID,
          rag: { enabled: true },
        });
        trackAgent(ragAgent);

        // Ingest test documents
        await ragAgent.ingestDocuments([
          {
            id: 'doc-1',
            content: 'The SnapAgent SDK was created by ViloTech in 2024.',
            metadata: { source: 'test' },
          },
          {
            id: 'doc-2',
            content: 'SnapAgent supports OpenAI, Anthropic, and Google providers.',
            metadata: { source: 'test' },
          },
        ]);

        // Create thread and query
        const ragThread = await client.createThread({
          agentId: ragAgent.id,
          userId: TEST_USER_ID,
        });
        trackThread(ragThread);

        const response = await client.chat({
          threadId: ragThread.id,
          message: 'Who created the SnapAgent SDK?',
          useRAG: true,
        });

        expect(response.reply.toLowerCase()).toContain('vilotech');
        console.log(`  RAG response: "${response.reply}"`);
      },
      { timeout: 60000 }
    );
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error Handling', () => {
    it.skipIf(!hasOpenAI)('should throw AgentNotFoundError for invalid agent ID', async () => {
      await expect(client.getAgent('non-existent-agent-id')).rejects.toThrow();
    });

    it.skipIf(!hasOpenAI)('should throw ThreadNotFoundError for invalid thread ID', async () => {
      await expect(client.getThread('non-existent-thread-id')).rejects.toThrow();
    });

    it.skipIf(!hasOpenAI)('should throw when creating thread with invalid agent', async () => {
      await expect(
        client.createThread({
          agentId: 'non-existent-agent',
          userId: TEST_USER_ID,
        })
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // Cleanup Verification
  // ============================================================================

  describe('Cleanup Operations', () => {
    it.skipIf(!hasOpenAI)('should delete an agent and its threads', async () => {
      // Create agent with threads
      const agent = await client.createAgent({
        name: 'Cleanup Test Agent',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: TEST_USER_ID,
      });
      // Don't track - we're testing deletion

      const thread = await client.createThread({
        agentId: agent.id,
        userId: TEST_USER_ID,
      });
      // Don't track - should be deleted with agent

      // Delete agent
      await client.deleteAgent(agent.id);

      // Verify agent is gone
      await expect(client.getAgent(agent.id)).rejects.toThrow();

      // Verify thread is gone (if using MemoryStorage, it cascades)
      if (storage instanceof MemoryStorage) {
        await expect(client.getThread(thread.id)).rejects.toThrow();
      }
    });
  });
});

