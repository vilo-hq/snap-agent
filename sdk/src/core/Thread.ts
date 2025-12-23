import type { UserModelMessage, AssistantModelMessage } from 'ai';
import {
  ThreadConfig,
  ThreadData,
  MessageData,
  MessageAttachment,
  MessageRole,
  StorageAdapter,
  CouldNotCreateThreadError,
} from '../types';

// Type for messages accepted by the AI SDK
type AIMessage = UserModelMessage | AssistantModelMessage;

/**
 * Thread class representing a conversation thread
 */
export class Thread {
  private data: ThreadData;
  private storage: StorageAdapter;

  constructor(data: ThreadData, storage: StorageAdapter) {
    this.data = data;
    this.storage = storage;
  }

  /**
   * Create a new thread
   */
  static async create(
    config: ThreadConfig,
    storage: StorageAdapter
  ): Promise<Thread> {
    const threadId = await storage.createThread(config);
    const data = await storage.getThread(threadId);

    if (!data) {
      throw new CouldNotCreateThreadError(threadId);
    }

    return new Thread(data, storage);
  }

  /**
   * Load an existing thread by ID
   */
  static async load(
    threadId: string,
    storage: StorageAdapter
  ): Promise<Thread | null> {
    const data = await storage.getThread(threadId);

    if (!data) {
      return null;
    }

    return new Thread(data, storage);
  }

  /**
   * Update thread properties
   */
  async update(updates: Partial<ThreadConfig>): Promise<void> {
    await this.storage.updateThread(this.data.id, updates);

    // Reload data
    const updatedData = await this.storage.getThread(this.data.id);
    if (updatedData) {
      this.data = updatedData;
    }
  }

  /**
   * Delete this thread
   */
  async delete(): Promise<void> {
    await this.storage.deleteThread(this.data.id);
  }

  /**
   * Add a message to the thread
   */
  async addMessage(
    role: MessageRole,
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<string> {
    const messageId = await this.storage.addMessage(
      this.data.id,
      role,
      content,
      attachments
    );

    // Reload data to include new message
    const updatedData = await this.storage.getThread(this.data.id);
    if (updatedData) {
      this.data = updatedData;
    }

    return messageId;
  }

  /**
   * Get messages from this thread
   */
  async getMessages(limit?: number): Promise<MessageData[]> {
    return await this.storage.getMessages(this.data.id, limit);
  }

  /**
   * Get conversation context for AI (formatted for Vercel AI SDK)
   */
  async getConversationContext(maxMessages: number = 20): Promise<AIMessage[]> {
    const messages = await this.storage.getMessages(this.data.id, maxMessages);

    return messages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })) as AIMessage[];
  }

  /**
   * Update thread name
   */
  async updateName(name: string): Promise<void> {
    await this.update({ name });
  }

  /**
   * Update pending status
   */
  async updatePendingStatus(isPending: boolean): Promise<void> {
    this.data.isPendingThread = isPending;
    this.data.updatedAt = new Date();
  }

  /**
   * Get thread ID
   */
  get id(): string {
    return this.data.id;
  }

  /**
   * Get thread name
   */
  get name(): string | undefined {
    return this.data.name;
  }

  /**
   * Get agent ID
   */
  get agentId(): string {
    return this.data.agentId;
  }

  /**
   * Get messages (cached from last load)
   */
  get messages(): MessageData[] {
    return this.data.messages;
  }

  /**
   * Check if thread is pending
   */
  get isPending(): boolean {
    return this.data.isPendingThread;
  }

  /**
   * Get all thread data
   */
  toJSON(): ThreadData {
    return { ...this.data };
  }
}

