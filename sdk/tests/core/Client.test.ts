import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AgentClient } from '../../src/core/Client';
import { Agent } from '../../src/core/Agent';
import { Thread } from '../../src/core/Thread';
import { MemoryStorage } from '../../src/storage/MemoryStorage';
import {
  InvalidConfigError,
  AgentNotFoundError,
  ThreadNotFoundError,
} from '../../src/types';

// Mock the Agent and Thread classes
vi.mock('../../src/core/Agent');
vi.mock('../../src/core/Thread');

// Mock the ai module
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'Mocked response' }),
  streamText: vi.fn(),
}));

describe('AgentClient', () => {
  let storage: MemoryStorage;
  let client: AgentClient;

  const validProviders = {
    openai: { apiKey: 'test-openai-key' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new MemoryStorage();
    client = new AgentClient({
      storage,
      providers: validProviders,
    });
  });

  // ============================================================================
  // Constructor & Configuration Validation
  // ============================================================================

  describe('constructor', () => {
    it('should create a client with valid config', () => {
      expect(client).toBeInstanceOf(AgentClient);
    });

    it('should throw InvalidConfigError when storage is missing', () => {
      expect(
        () =>
          new AgentClient({
            storage: undefined as any,
            providers: validProviders,
          })
      ).toThrow(InvalidConfigError);
    });

    it('should throw InvalidConfigError when storage is null', () => {
      expect(
        () =>
          new AgentClient({
            storage: null as any,
            providers: validProviders,
          })
      ).toThrow(InvalidConfigError);
    });

    it('should throw InvalidConfigError when providers is empty', () => {
      expect(
        () =>
          new AgentClient({
            storage,
            providers: {},
          })
      ).toThrow(InvalidConfigError);
    });

    it('should throw InvalidConfigError when providers is undefined', () => {
      expect(
        () =>
          new AgentClient({
            storage,
            providers: undefined as any,
          })
      ).toThrow(InvalidConfigError);
    });

    it('should accept single provider config', () => {
      const singleProviderClient = new AgentClient({
        storage,
        providers: { openai: { apiKey: 'test-key' } },
      });
      expect(singleProviderClient).toBeInstanceOf(AgentClient);
    });

    it('should accept multiple provider configs', () => {
      const multiProviderClient = new AgentClient({
        storage,
        providers: {
          openai: { apiKey: 'openai-key' },
          anthropic: { apiKey: 'anthropic-key' },
          google: { apiKey: 'google-key' },
          huggingface: { apiKey: 'hf-key' },
        },
      });
      expect(multiProviderClient).toBeInstanceOf(AgentClient);
    });
  });

  // ============================================================================
  // Agent Operations
  // ============================================================================

  describe('createAgent', () => {
    const agentConfig = {
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      model: 'gpt-4o',
      userId: 'user-123',
    };

    const mockAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      delete: vi.fn(),
      generateResponse: vi.fn(),
    };

    beforeEach(() => {
      (Agent.create as Mock).mockResolvedValue(mockAgent);
    });

    it('should create an agent with minimal config', async () => {
      const agent = await client.createAgent(agentConfig);

      expect(Agent.create).toHaveBeenCalled();
      expect(agent).toBe(mockAgent);
    });

    it('should default provider to openai if not specified', async () => {
      await client.createAgent(agentConfig);

      expect(Agent.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai' }),
        storage,
        expect.anything()
      );
    });

    it('should use specified provider when provided', async () => {
      await client.createAgent({
        ...agentConfig,
        provider: 'anthropic',
      });

      expect(Agent.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' }),
        storage,
        expect.anything()
      );
    });

    it('should auto-instantiate DefaultRAGPlugin when rag.enabled is true', async () => {
      await client.createAgent({
        ...agentConfig,
        rag: { enabled: true },
      });

      expect(Agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({ type: 'rag' }),
          ]),
        }),
        storage,
        expect.anything()
      );
    });

    it('should throw InvalidConfigError when RAG enabled but no API key available', async () => {
      const noKeyClient = new AgentClient({
        storage,
        providers: { anthropic: { apiKey: 'anthropic-key' } },
      });

      await expect(
        noKeyClient.createAgent({
          ...agentConfig,
          rag: { enabled: true },
        })
      ).rejects.toThrow(InvalidConfigError);
    });

    it('should use provided embeddingProviderApiKey for RAG', async () => {
      await client.createAgent({
        ...agentConfig,
        rag: {
          enabled: true,
          embeddingProviderApiKey: 'custom-embedding-key',
        },
      });

      expect(Agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({ type: 'rag' }),
          ]),
        }),
        storage,
        expect.anything()
      );
    });

    it('should not duplicate RAG plugin if one already provided', async () => {
      const existingRAGPlugin = {
        type: 'rag' as const,
        name: 'existing-rag',
        retrieveContext: vi.fn(),
      };

      await client.createAgent({
        ...agentConfig,
        rag: { enabled: true },
        plugins: [existingRAGPlugin],
      });

      const calledWith = (Agent.create as Mock).mock.calls[0][0];
      const ragPlugins = calledWith.plugins.filter(
        (p: any) => p.type === 'rag'
      );
      expect(ragPlugins).toHaveLength(1);
    });

    it('should pass full config with organizationId and metadata', async () => {
      await client.createAgent({
        ...agentConfig,
        organizationId: 'org-123',
        metadata: { tier: 'premium' },
      });

      expect(Agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-123',
          metadata: { tier: 'premium' },
        }),
        storage,
        expect.anything()
      );
    });
  });

  describe('getAgent', () => {
    const mockAgent = {
      id: 'agent-1',
      name: 'Test Agent',
    };

    it('should return an Agent for valid ID', async () => {
      (Agent.load as Mock).mockResolvedValue(mockAgent);

      const agent = await client.getAgent('agent-1');

      expect(Agent.load).toHaveBeenCalledWith(
        'agent-1',
        storage,
        expect.anything(),
        expect.objectContaining({ plugins: undefined, registry: undefined })
      );
      expect(agent).toBe(mockAgent);
    });

    it('should throw AgentNotFoundError for non-existent agent', async () => {
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(client.getAgent('non-existent')).rejects.toThrow(
        AgentNotFoundError
      );
    });

    it('should throw AgentNotFoundError for empty string ID', async () => {
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(client.getAgent('')).rejects.toThrow(AgentNotFoundError);
    });
  });

  describe('listAgents', () => {
    it('should return agents filtered by userId', async () => {
      // Create real agents in storage
      await storage.createAgent({
        name: 'Agent 1',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-1',
      });
      await storage.createAgent({
        name: 'Agent 2',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-2',
      });

      const agents = await client.listAgents('user-1');

      expect(agents).toHaveLength(1);
      expect(agents[0].userId).toBe('user-1');
    });

    it('should return agents filtered by userId and organizationId', async () => {
      await storage.createAgent({
        name: 'Agent 1',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-1',
        organizationId: 'org-1',
      });
      await storage.createAgent({
        name: 'Agent 2',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-1',
        organizationId: 'org-2',
      });

      const agents = await client.listAgents('user-1', 'org-1');

      expect(agents).toHaveLength(1);
      expect(agents[0].organizationId).toBe('org-1');
    });

    it('should return empty array when no agents exist', async () => {
      const agents = await client.listAgents('user-999');

      expect(agents).toEqual([]);
    });
  });

  describe('deleteAgent', () => {
    it('should delete an existing agent', async () => {
      const mockAgent = { id: 'agent-1', delete: vi.fn() };
      (Agent.load as Mock).mockResolvedValue(mockAgent);

      await client.deleteAgent('agent-1');

      expect(mockAgent.delete).toHaveBeenCalled();
    });

    it('should throw AgentNotFoundError when agent does not exist', async () => {
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(client.deleteAgent('non-existent')).rejects.toThrow(
        AgentNotFoundError
      );
    });
  });

  // ============================================================================
  // Thread Operations
  // ============================================================================

  describe('createThread', () => {
    const mockAgent = { id: 'agent-1' };
    const mockThread = { id: 'thread-1', agentId: 'agent-1' };

    beforeEach(() => {
      (Agent.load as Mock).mockResolvedValue(mockAgent);
      (Thread.create as Mock).mockResolvedValue(mockThread);
    });

    it('should create a thread with valid agentId', async () => {
      const thread = await client.createThread({
        agentId: 'agent-1',
        userId: 'user-123',
      });

      expect(Agent.load).toHaveBeenCalledWith(
        'agent-1',
        storage,
        expect.anything(),
        expect.objectContaining({ plugins: undefined, registry: undefined })
      );
      expect(Thread.create).toHaveBeenCalled();
      expect(thread).toBe(mockThread);
    });

    it('should throw AgentNotFoundError when agentId is invalid', async () => {
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(
        client.createThread({ agentId: 'invalid', userId: 'user-123' })
      ).rejects.toThrow(AgentNotFoundError);
    });

    it('should create thread with optional name', async () => {
      await client.createThread({
        agentId: 'agent-1',
        userId: 'user-123',
        name: 'Support Chat',
      });

      expect(Thread.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Support Chat' }),
        storage
      );
    });

    it('should create thread with metadata', async () => {
      await client.createThread({
        agentId: 'agent-1',
        userId: 'user-123',
        metadata: { source: 'web' },
      });

      expect(Thread.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { source: 'web' } }),
        storage
      );
    });
  });

  describe('getThread', () => {
    const mockThread = { id: 'thread-1', agentId: 'agent-1' };

    it('should return a Thread for valid ID', async () => {
      (Thread.load as Mock).mockResolvedValue(mockThread);

      const thread = await client.getThread('thread-1');

      expect(Thread.load).toHaveBeenCalledWith('thread-1', storage);
      expect(thread).toBe(mockThread);
    });

    it('should throw ThreadNotFoundError for non-existent thread', async () => {
      (Thread.load as Mock).mockResolvedValue(null);

      await expect(client.getThread('non-existent')).rejects.toThrow(
        ThreadNotFoundError
      );
    });

    it('should throw ThreadNotFoundError when threadId is undefined', async () => {
      await expect(client.getThread(undefined)).rejects.toThrow(
        ThreadNotFoundError
      );
    });

    it('should throw ThreadNotFoundError when threadId is empty string', async () => {
      (Thread.load as Mock).mockResolvedValue(null);

      await expect(client.getThread('')).rejects.toThrow(ThreadNotFoundError);
    });
  });

  describe('listThreads', () => {
    it('should return threads filtered by agentId', async () => {
      const agentId = await storage.createAgent({
        name: 'Agent',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-1',
      });

      await storage.createThread({ agentId, userId: 'user-1' });
      await storage.createThread({ agentId, userId: 'user-1' });

      const threads = await client.listThreads({ agentId });

      expect(threads).toHaveLength(2);
    });

    it('should return threads filtered by userId', async () => {
      const agentId = await storage.createAgent({
        name: 'Agent',
        instructions: 'Test',
        provider: 'openai',
        model: 'gpt-4o',
        userId: 'user-1',
      });

      await storage.createThread({ agentId, userId: 'user-1' });
      await storage.createThread({ agentId, userId: 'user-2' });

      const threads = await client.listThreads({ userId: 'user-1' });

      expect(threads).toHaveLength(1);
    });

    it('should return empty array when no threads exist', async () => {
      const threads = await client.listThreads({ agentId: 'non-existent' });

      expect(threads).toEqual([]);
    });
  });

  describe('deleteThread', () => {
    it('should delete an existing thread', async () => {
      const mockThread = { id: 'thread-1', delete: vi.fn() };
      (Thread.load as Mock).mockResolvedValue(mockThread);

      await client.deleteThread('thread-1');

      expect(mockThread.delete).toHaveBeenCalled();
    });

    it('should throw ThreadNotFoundError when thread does not exist', async () => {
      (Thread.load as Mock).mockResolvedValue(null);

      await expect(client.deleteThread('non-existent')).rejects.toThrow(
        ThreadNotFoundError
      );
    });
  });

  // ============================================================================
  // Chat Operations (Non-Streaming)
  // ============================================================================

  describe('chat', () => {
    const mockAgent = {
      id: 'agent-1',
      generateResponse: vi.fn().mockResolvedValue({
        text: 'Hello! How can I help?',
        metadata: { latency: 100 },
      }),
    };

    const mockThread = {
      id: 'thread-1',
      agentId: 'agent-1',
      addMessage: vi.fn().mockResolvedValue('msg-1'),
      getConversationContext: vi.fn().mockResolvedValue([
        { role: 'user', content: 'Hi!' },
      ]),
    };

    beforeEach(() => {
      (Agent.load as Mock).mockResolvedValue(mockAgent);
      (Thread.load as Mock).mockResolvedValue(mockThread);
    });

    it('should send message and return response', async () => {
      const response = await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
      });

      expect(response.reply).toBe('Hello! How can I help?');
      expect(response.threadId).toBe('thread-1');
      expect(response.messageId).toBeDefined();
    });

    it('should add user message to thread before generating', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Hello!',
      });

      expect(mockThread.addMessage).toHaveBeenCalledWith(
        'user',
        'Hello!',
        undefined
      );
    });

    it('should add assistant response to thread after generating', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
      });

      // First call is user message, second is assistant response
      expect(mockThread.addMessage).toHaveBeenCalledTimes(2);
      expect(mockThread.addMessage).toHaveBeenLastCalledWith(
        'assistant',
        'Hello! How can I help?'
      );
    });

    it('should use default contextLength of 20', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
      });

      expect(mockThread.getConversationContext).toHaveBeenCalledWith(20);
    });

    it('should respect custom contextLength', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
        contextLength: 50,
      });

      expect(mockThread.getConversationContext).toHaveBeenCalledWith(50);
    });

    it('should pass useRAG option to agent', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Find me a product',
        useRAG: true,
      });

      expect(mockAgent.generateResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ useRAG: true })
      );
    });

    it('should pass ragFilters to agent', async () => {
      await client.chat({
        threadId: 'thread-1',
        message: 'Find shoes',
        useRAG: true,
        ragFilters: { category: 'footwear' },
      });

      expect(mockAgent.generateResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ragFilters: { category: 'footwear' } })
      );
    });

    it('should return correct ChatResponse structure', async () => {
      const response = await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
      });

      expect(response).toMatchObject({
        reply: expect.any(String),
        messageId: expect.any(String),
        threadId: 'thread-1',
        timestamp: expect.any(Date),
      });
    });

    it('should throw ThreadNotFoundError for invalid threadId', async () => {
      (Thread.load as Mock).mockResolvedValue(null);

      await expect(
        client.chat({ threadId: 'invalid', message: 'Hi!' })
      ).rejects.toThrow(ThreadNotFoundError);
    });

    it('should throw AgentNotFoundError when thread agent does not exist', async () => {
      (Thread.load as Mock).mockResolvedValue(mockThread);
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(
        client.chat({ threadId: 'thread-1', message: 'Hi!' })
      ).rejects.toThrow(AgentNotFoundError);
    });

    it('should include metadata from plugins in response', async () => {
      const response = await client.chat({
        threadId: 'thread-1',
        message: 'Hi!',
      });

      expect(response.metadata).toEqual({ latency: 100 });
    });

    it('should pass attachments to thread', async () => {
      const attachments = [
        { fileId: 'file-1', filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 },
      ];

      await client.chat({
        threadId: 'thread-1',
        message: 'Check this file',
        attachments,
      });

      expect(mockThread.addMessage).toHaveBeenCalledWith(
        'user',
        'Check this file',
        attachments
      );
    });
  });

  // ============================================================================
  // Chat Operations (Streaming)
  // ============================================================================

  describe('chatStream', () => {
    const mockAgent = {
      id: 'agent-1',
      streamResponse: vi.fn(),
    };

    const mockThread = {
      id: 'thread-1',
      agentId: 'agent-1',
      addMessage: vi.fn().mockResolvedValue('msg-1'),
      getConversationContext: vi.fn().mockResolvedValue([]),
    };

    const callbacks = {
      onChunk: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    beforeEach(() => {
      (Agent.load as Mock).mockResolvedValue(mockAgent);
      (Thread.load as Mock).mockResolvedValue(mockThread);
      mockAgent.streamResponse.mockImplementation(
        async (_msgs, onChunk, onComplete) => {
          onChunk('Hello');
          onChunk(' world');
          await onComplete('Hello world', { latency: 50 });
        }
      );
    });

    it('should stream response chunks via onChunk callback', async () => {
      await client.chatStream(
        { threadId: 'thread-1', message: 'Hi!' },
        callbacks
      );

      expect(mockAgent.streamResponse).toHaveBeenCalled();
    });

    it('should add user message to thread before streaming', async () => {
      await client.chatStream(
        { threadId: 'thread-1', message: 'Hello!' },
        callbacks
      );

      expect(mockThread.addMessage).toHaveBeenCalledWith(
        'user',
        'Hello!',
        undefined
      );
    });

    it('should call onError when thread not found', async () => {
      (Thread.load as Mock).mockResolvedValue(null);

      await client.chatStream(
        { threadId: 'invalid', message: 'Hi!' },
        callbacks
      );

      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.any(ThreadNotFoundError)
      );
    });

    it('should call onError when agent not found', async () => {
      (Thread.load as Mock).mockResolvedValue(mockThread);
      (Agent.load as Mock).mockResolvedValue(null);

      await client.chatStream(
        { threadId: 'thread-1', message: 'Hi!' },
        callbacks
      );

      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.any(AgentNotFoundError)
      );
    });

    it('should pass useRAG option to agent', async () => {
      await client.chatStream(
        { threadId: 'thread-1', message: 'Find products', useRAG: true },
        callbacks
      );

      expect(mockAgent.streamResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ useRAG: true })
      );
    });

    it('should respect custom contextLength', async () => {
      await client.chatStream(
        { threadId: 'thread-1', message: 'Hi!', contextLength: 100 },
        callbacks
      );

      expect(mockThread.getConversationContext).toHaveBeenCalledWith(100);
    });
  });

  // ============================================================================
  // Utility Methods
  // ============================================================================

  describe('getConfiguredProviders', () => {
    it('should return list of configured provider names', () => {
      const multiClient = new AgentClient({
        storage,
        providers: {
          openai: { apiKey: 'key1' },
          anthropic: { apiKey: 'key2' },
          huggingface: { apiKey: 'key3' },
        },
      });

      const providers = multiClient.getConfiguredProviders();

      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
      expect(providers).toContain('huggingface');
    });
  });

  describe('isProviderConfigured', () => {
    it('should return true for configured provider', () => {
      expect(client.isProviderConfigured('openai')).toBe(true);
    });

    it('should return false for unconfigured provider', () => {
      expect(client.isProviderConfigured('anthropic')).toBe(false);
    });

    it('should return true for huggingface when configured', () => {
      const hfClient = new AgentClient({
        storage,
        providers: { huggingface: { apiKey: 'hf-test-key' } },
      });
      expect(hfClient.isProviderConfigured('huggingface')).toBe(true);
    });

    it('should return false for huggingface when not configured', () => {
      expect(client.isProviderConfigured('huggingface')).toBe(false);
    });
  });

  // ============================================================================
  // Headless / Backend Execution (run)
  // ============================================================================

  describe('run', () => {
    const mockAgent = {
      id: 'agent-1',
      generateResponse: vi.fn().mockResolvedValue({
        text: 'Processed successfully',
        metadata: { latency: 50 },
      }),
    };

    beforeEach(() => {
      (Agent.load as Mock).mockResolvedValue(mockAgent);
      mockAgent.generateResponse.mockClear();
    });

    it('should execute agent with input and return output', async () => {
      const result = await client.run({
        agentId: 'agent-1',
        input: 'Process this order',
      });

      expect(result.output).toBe('Processed successfully');
      expect(result.metadata).toEqual({ latency: 50 });
    });

    it('should pass input as a user message to generateResponse', async () => {
      await client.run({
        agentId: 'agent-1',
        input: 'Summarize this document',
      });

      expect(mockAgent.generateResponse).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Summarize this document' }],
        expect.objectContaining({})
      );
    });

    it('should append serialized payload to the input', async () => {
      await client.run({
        agentId: 'agent-1',
        input: 'Process this',
        payload: { orderId: '123', amount: 99.99 },
      });

      const calledMessages = mockAgent.generateResponse.mock.calls[0][0];
      expect(calledMessages[0].content).toContain('Process this');
      expect(calledMessages[0].content).toContain('"orderId": "123"');
      expect(calledMessages[0].content).toContain('"amount": 99.99');
    });

    it('should forward useRAG and ragFilters options', async () => {
      await client.run({
        agentId: 'agent-1',
        input: 'Find related docs',
        useRAG: true,
        ragFilters: { category: 'support' },
      });

      expect(mockAgent.generateResponse).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          useRAG: true,
          ragFilters: { category: 'support' },
        })
      );
    });

    it('should forward maxToolSteps option', async () => {
      await client.run({
        agentId: 'agent-1',
        input: 'Do something',
        maxToolSteps: 10,
      });

      expect(mockAgent.generateResponse).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          maxToolSteps: 10,
        })
      );
    });

    it('should not include webhookDelivery when no webhook is configured', async () => {
      const result = await client.run({
        agentId: 'agent-1',
        input: 'Test',
      });

      expect(result.webhookDelivery).toBeUndefined();
    });

    it('should deliver result to webhook and include delivery status', async () => {
      // Mock fetch for webhook delivery
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }) as any;

      try {
        const result = await client.run({
          agentId: 'agent-1',
          input: 'Process this',
          webhook: {
            url: 'https://example.com/hook',
          },
        });

        expect(result.webhookDelivery).toEqual({
          success: true,
          statusCode: 200,
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
          'https://example.com/hook',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          })
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should include custom headers in webhook request', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

      try {
        await client.run({
          agentId: 'agent-1',
          input: 'Test',
          webhook: {
            url: 'https://example.com/hook',
            headers: { 'X-Custom': 'value' },
          },
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
          'https://example.com/hook',
          expect.objectContaining({
            headers: expect.objectContaining({ 'X-Custom': 'value' }),
          })
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle webhook delivery failure gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

      try {
        const result = await client.run({
          agentId: 'agent-1',
          input: 'Test',
          webhook: { url: 'https://example.com/hook' },
        });

        expect(result.webhookDelivery).toEqual({
          success: false,
          error: 'Network error',
        });
        // The run itself should still succeed
        expect(result.output).toBe('Processed successfully');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should throw AgentNotFoundError for non-existent agent', async () => {
      (Agent.load as Mock).mockResolvedValue(null);

      await expect(
        client.run({ agentId: 'non-existent', input: 'Test' })
      ).rejects.toThrow(AgentNotFoundError);
    });

    it('should include HMAC signature when webhook secret is provided', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

      try {
        await client.run({
          agentId: 'agent-1',
          input: 'Test',
          webhook: {
            url: 'https://example.com/hook',
            secret: 'test-secret',
          },
        });

        const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
        const headers = fetchCall[1].headers;
        expect(headers['X-Signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

