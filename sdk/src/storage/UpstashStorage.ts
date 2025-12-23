import {
  StorageAdapter,
  AgentConfig,
  AgentData,
  ThreadConfig,
  ThreadData,
  MessageData,
  MessageRole,
  MessageAttachment,
} from '../types';

/**
 * Upstash Redis configuration
 */
export interface UpstashStorageConfig {
  /**
   * Upstash Redis REST URL
   * @example "https://your-redis.upstash.io"
   */
  url: string;

  /**
   * Upstash Redis REST token
   */
  token: string;

  /**
   * Optional key prefix for multi-tenancy
   * @default "snap-agent"
   */
  prefix?: string;
}

/**
 * Internal types for Redis storage
 */
interface StoredAgent {
  id: string;
  organizationId?: string;
  userId: string;
  phone?: string;
  name: string;
  description?: string;
  instructions: string;
  provider: string;
  model: string;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  files: string; // JSON stringified AgentFile[]
  metadata?: string; // JSON stringified
}

interface StoredThread {
  id: string;
  organizationId?: string;
  agentId: string;
  userId: string;
  endUserId?: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  messages: string; // JSON stringified MessageData[]
  isPendingThread: string; // "true" or "false"
  metadata?: string;
}

/**
 * Upstash Redis Storage Adapter
 *
 * Edge-compatible persistent storage using Upstash Redis REST API.
 * Works with Cloudflare Workers, Vercel Edge, Deno Deploy, and any WinterCG runtime.
 *
 * @example
 * ```typescript
 * import { UpstashStorage } from '@snap-agent/core/storage';
 *
 * const storage = new UpstashStorage({
 *   url: process.env.UPSTASH_REDIS_REST_URL!,
 *   token: process.env.UPSTASH_REDIS_REST_TOKEN!,
 * });
 *
 * const client = createClient({
 *   storage,
 *   providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
 * });
 * ```
 */
export class UpstashStorage implements StorageAdapter {
  private url: string;
  private token: string;
  private prefix: string;

  constructor(config: UpstashStorageConfig) {
    this.url = config.url.replace(/\/$/, ''); // Remove trailing slash
    this.token = config.token;
    this.prefix = config.prefix || 'snap-agent';
  }

  // ============================================================================
  // Redis Commands via REST API
  // ============================================================================

  private async command<T = unknown>(
    cmd: string,
    ...args: (string | number)[]
  ): Promise<T> {
    const body = [cmd, ...args];

    const response = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upstash Redis error: ${response.status} - ${text}`);
    }

    const data = (await response.json()) as { result?: T; error?: string };

    if (data.error) {
      throw new Error(`Upstash Redis error: ${data.error}`);
    }

    return data.result as T;
  }

  private async pipeline<T = unknown>(
    commands: Array<[string, ...Array<string | number>]>
  ): Promise<T[]> {
    const response = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upstash Redis pipeline error: ${response.status} - ${text}`);
    }

    const data = (await response.json()) as Array<{ result?: T; error?: string }>;

    // Pipeline returns array of results
    return data.map((item) => {
      if (item.error) {
        throw new Error(`Upstash Redis error: ${item.error}`);
      }
      return item.result as T;
    });
  }

  // ============================================================================
  // Key Generation
  // ============================================================================

  private key(...parts: string[]): string {
    return `${this.prefix}:${parts.join(':')}`;
  }

  private generateId(): string {
    // Generate a unique ID using timestamp + random
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}${random}`;
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  async createAgent(config: AgentConfig): Promise<string> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const stored: StoredAgent = {
      id,
      organizationId: config.organizationId,
      userId: config.userId,
      phone: config.phone,
      name: config.name,
      description: config.description,
      instructions: config.instructions,
      provider: config.provider,
      model: config.model,
      createdAt: now,
      updatedAt: now,
      files: JSON.stringify([]),
      metadata: config.metadata ? JSON.stringify(config.metadata) : undefined,
    };

    // Build hash fields array
    const fields: (string | number)[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (value !== undefined) {
        fields.push(key, String(value));
      }
    }

    // Store agent and add to user index
    await this.pipeline([
      ['HSET', this.key('agent', id), ...fields],
      ['SADD', this.key('agents:user', config.userId), id],
      ...(config.organizationId
        ? [['SADD', this.key('agents:org', config.organizationId), id] as [string, ...string[]]]
        : []),
    ]);

    return id;
  }

  async getAgent(agentId: string): Promise<AgentData | null> {
    const data = await this.command<Record<string, string> | null>(
      'HGETALL',
      this.key('agent', agentId)
    );

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return this.parseStoredAgent(data as unknown as StoredAgent);
  }

  async updateAgent(
    agentId: string,
    updates: Partial<AgentConfig>
  ): Promise<void> {
    const fields: (string | number)[] = ['updatedAt', new Date().toISOString()];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (key === 'metadata') {
          fields.push(key, JSON.stringify(value));
        } else {
          fields.push(key, String(value));
        }
      }
    }

    await this.command('HSET', this.key('agent', agentId), ...fields);
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Get agent to find userId and orgId for index cleanup
    const agent = await this.getAgent(agentId);
    if (!agent) return;

    // Get all threads for this agent
    const threadIds = await this.command<string[]>(
      'SMEMBERS',
      this.key('threads:agent', agentId)
    );

    // Build pipeline to delete everything
    const commands: Array<[string, ...Array<string | number>]> = [
      ['DEL', this.key('agent', agentId)],
      ['SREM', this.key('agents:user', agent.userId), agentId],
    ];

    if (agent.organizationId) {
      commands.push(['SREM', this.key('agents:org', agent.organizationId), agentId]);
    }

    // Delete all threads
    for (const threadId of threadIds || []) {
      commands.push(['DEL', this.key('thread', threadId)]);
    }
    commands.push(['DEL', this.key('threads:agent', agentId)]);

    await this.pipeline(commands);
  }

  async listAgents(
    userId: string,
    organizationId?: string
  ): Promise<AgentData[]> {
    // Get agent IDs from index
    const indexKey = organizationId
      ? this.key('agents:org', organizationId)
      : this.key('agents:user', userId);

    const agentIds = await this.command<string[]>('SMEMBERS', indexKey);

    if (!agentIds || agentIds.length === 0) {
      return [];
    }

    // Fetch all agents
    const agents: AgentData[] = [];
    for (const id of agentIds) {
      const agent = await this.getAgent(id);
      if (agent) {
        // Filter by userId if we used org index
        if (!organizationId || agent.userId === userId) {
          agents.push(agent);
        }
      }
    }

    // Sort by updatedAt descending
    return agents.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  // ============================================================================
  // Thread Operations
  // ============================================================================

  async createThread(config: ThreadConfig): Promise<string> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const stored: StoredThread = {
      id,
      organizationId: config.organizationId,
      agentId: config.agentId,
      userId: config.userId,
      endUserId: config.endUserId,
      name: config.name,
      createdAt: now,
      updatedAt: now,
      messages: JSON.stringify([]),
      isPendingThread: 'true',
      metadata: config.metadata ? JSON.stringify(config.metadata) : undefined,
    };

    // Build hash fields
    const fields: (string | number)[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (value !== undefined) {
        fields.push(key, String(value));
      }
    }

    // Store thread and add to indexes
    await this.pipeline([
      ['HSET', this.key('thread', id), ...fields],
      ['SADD', this.key('threads:agent', config.agentId), id],
      ['SADD', this.key('threads:user', config.userId), id],
      ...(config.organizationId
        ? [['SADD', this.key('threads:org', config.organizationId), id] as [string, ...string[]]]
        : []),
    ]);

    return id;
  }

  async getThread(threadId: string): Promise<ThreadData | null> {
    const data = await this.command<Record<string, string> | null>(
      'HGETALL',
      this.key('thread', threadId)
    );

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return this.parseStoredThread(data as unknown as StoredThread);
  }

  async updateThread(
    threadId: string,
    updates: Partial<ThreadConfig>
  ): Promise<void> {
    const fields: (string | number)[] = ['updatedAt', new Date().toISOString()];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (key === 'metadata') {
          fields.push(key, JSON.stringify(value));
        } else {
          fields.push(key, String(value));
        }
      }
    }

    await this.command('HSET', this.key('thread', threadId), ...fields);
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = await this.getThread(threadId);
    if (!thread) return;

    const commands: Array<[string, ...Array<string | number>]> = [
      ['DEL', this.key('thread', threadId)],
      ['SREM', this.key('threads:agent', thread.agentId), threadId],
      ['SREM', this.key('threads:user', thread.userId), threadId],
    ];

    if (thread.organizationId) {
      commands.push(['SREM', this.key('threads:org', thread.organizationId), threadId]);
    }

    await this.pipeline(commands);
  }

  async listThreads(filters: {
    userId?: string;
    agentId?: string;
    organizationId?: string;
  }): Promise<ThreadData[]> {
    // Determine which index to use
    let indexKey: string;
    if (filters.agentId) {
      indexKey = this.key('threads:agent', filters.agentId);
    } else if (filters.organizationId) {
      indexKey = this.key('threads:org', filters.organizationId);
    } else if (filters.userId) {
      indexKey = this.key('threads:user', filters.userId);
    } else {
      return [];
    }

    const threadIds = await this.command<string[]>('SMEMBERS', indexKey);

    if (!threadIds || threadIds.length === 0) {
      return [];
    }

    // Fetch all threads and apply filters
    const threads: ThreadData[] = [];
    for (const id of threadIds) {
      const thread = await this.getThread(id);
      if (thread) {
        // Apply additional filters
        if (filters.userId && thread.userId !== filters.userId) continue;
        if (filters.agentId && thread.agentId !== filters.agentId) continue;
        if (filters.organizationId && thread.organizationId !== filters.organizationId) continue;
        threads.push(thread);
      }
    }

    // Sort by updatedAt descending
    return threads.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  // ============================================================================
  // Message Operations
  // ============================================================================

  async addMessage(
    threadId: string,
    role: MessageRole,
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<string> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const messageId = this.generateId();
    const message: MessageData = {
      id: messageId,
      role,
      content,
      timestamp: new Date(),
      attachments,
    };

    thread.messages.push(message);

    // Update thread with new messages
    await this.command(
      'HSET',
      this.key('thread', threadId),
      'messages',
      JSON.stringify(thread.messages),
      'updatedAt',
      new Date().toISOString(),
      'isPendingThread',
      'false'
    );

    return messageId;
  }

  async getMessages(threadId: string, limit?: number): Promise<MessageData[]> {
    const thread = await this.getThread(threadId);
    if (!thread) return [];

    const messages = [...thread.messages];

    if (limit) {
      return messages.slice(-limit);
    }

    return messages;
  }

  async getConversationContext(
    threadId: string,
    maxMessages: number = 20
  ): Promise<Array<{ role: string; content: string }>> {
    const messages = await this.getMessages(threadId, maxMessages);
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private parseStoredAgent(stored: StoredAgent): AgentData {
    return {
      id: stored.id,
      organizationId: stored.organizationId,
      userId: stored.userId,
      phone: stored.phone,
      name: stored.name,
      description: stored.description,
      instructions: stored.instructions,
      provider: stored.provider as AgentData['provider'],
      model: stored.model,
      createdAt: new Date(stored.createdAt),
      updatedAt: new Date(stored.updatedAt),
      files: stored.files ? JSON.parse(stored.files) : [],
      metadata: stored.metadata ? JSON.parse(stored.metadata) : undefined,
    };
  }

  private parseStoredThread(stored: StoredThread): ThreadData {
    const messages: MessageData[] = stored.messages
      ? JSON.parse(stored.messages)
      : [];

    // Parse message timestamps
    const parsedMessages = messages.map((msg) => ({
      ...msg,
      timestamp: new Date(msg.timestamp),
    }));

    return {
      id: stored.id,
      organizationId: stored.organizationId,
      agentId: stored.agentId,
      userId: stored.userId,
      endUserId: stored.endUserId,
      name: stored.name,
      createdAt: new Date(stored.createdAt),
      updatedAt: new Date(stored.updatedAt),
      messages: parsedMessages,
      isPendingThread: stored.isPendingThread === 'true',
      metadata: stored.metadata ? JSON.parse(stored.metadata) : undefined,
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Test connection to Upstash Redis
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.command<string>('PING');
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Clear all data with this prefix (use with caution!)
   */
  async clear(): Promise<void> {
    // Get all keys with our prefix
    const keys = await this.command<string[]>('KEYS', `${this.prefix}:*`);

    if (keys && keys.length > 0) {
      await this.command('DEL', ...keys);
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    agents: number;
    threads: number;
  }> {
    const [agentKeys, threadKeys] = await this.pipeline<string[]>([
      ['KEYS', `${this.prefix}:agent:*`],
      ['KEYS', `${this.prefix}:thread:*`],
    ]);

    return {
      agents: agentKeys?.length || 0,
      threads: threadKeys?.length || 0,
    };
  }
}

