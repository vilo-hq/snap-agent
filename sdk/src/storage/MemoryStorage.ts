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
 * In-Memory Storage Adapter
 * Provides temporary storage for agents and threads (useful for testing and development)
 */
export class MemoryStorage implements StorageAdapter {
  private agents: Map<string, AgentData> = new Map();
  private threads: Map<string, ThreadData> = new Map();
  private idCounter = 0;

  private generateId(): string {
    return `${Date.now()}-${++this.idCounter}`;
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  async createAgent(config: AgentConfig): Promise<string> {
    const id = this.generateId();
    const agent: AgentData = {
      id,
      ...config,
      createdAt: new Date(),
      updatedAt: new Date(),
      files: [],
    };

    this.agents.set(id, agent);
    return id;
  }

  async getAgent(agentId: string): Promise<AgentData | null> {
    return this.agents.get(agentId) || null;
  }

  async updateAgent(
    agentId: string,
    updates: Partial<AgentConfig>
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    Object.assign(agent, updates, { updatedAt: new Date() });
    this.agents.set(agentId, agent);
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.agents.delete(agentId);
    
    // Also delete associated threads
    const threadsToDelete: string[] = [];
    for (const [threadId, thread] of this.threads.entries()) {
      if (thread.agentId === agentId) {
        threadsToDelete.push(threadId);
      }
    }
    
    for (const threadId of threadsToDelete) {
      this.threads.delete(threadId);
    }
  }

  async listAgents(
    userId: string,
    organizationId?: string
  ): Promise<AgentData[]> {
    const agents = Array.from(this.agents.values()).filter((agent) => {
      if (agent.userId !== userId) return false;
      if (organizationId && agent.organizationId !== organizationId) return false;
      return true;
    });

    return agents.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  // ============================================================================
  // Thread Operations
  // ============================================================================

  async createThread(config: ThreadConfig): Promise<string> {
    const id = this.generateId();
    const thread: ThreadData = {
      id,
      ...config,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      isPendingThread: true,
    };

    this.threads.set(id, thread);
    return id;
  }

  async getThread(threadId: string): Promise<ThreadData | null> {
    return this.threads.get(threadId) || null;
  }

  async updateThread(
    threadId: string,
    updates: Partial<ThreadConfig>
  ): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;

    Object.assign(thread, updates, { updatedAt: new Date() });
    this.threads.set(threadId, thread);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async listThreads(filters: {
    userId?: string;
    agentId?: string;
    organizationId?: string;
  }): Promise<ThreadData[]> {
    const threads = Array.from(this.threads.values()).filter((thread) => {
      if (filters.userId && thread.userId !== filters.userId) return false;
      if (filters.agentId && thread.agentId !== filters.agentId) return false;
      if (filters.organizationId && thread.organizationId !== filters.organizationId) return false;
      return true;
    });

    return threads.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
    const thread = this.threads.get(threadId);
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
    thread.updatedAt = new Date();
    this.threads.set(threadId, thread);

    return messageId;
  }

  async getMessages(threadId: string, limit?: number): Promise<MessageData[]> {
    const thread = this.threads.get(threadId);
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
  // Utility Methods
  // ============================================================================

  /**
   * Clear all stored data
   */
  clear(): void {
    this.agents.clear();
    this.threads.clear();
    this.idCounter = 0;
  }

  /**
   * Get statistics about stored data
   */
  getStats() {
    return {
      agents: this.agents.size,
      threads: this.threads.size,
      messages: Array.from(this.threads.values()).reduce(
        (sum, thread) => sum + thread.messages.length,
        0
      ),
    };
  }
}

