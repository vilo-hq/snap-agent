import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import {
  StorageAdapter,
  AgentConfig,
  AgentData,
  ThreadConfig,
  ThreadData,
  MessageData,
  MessageRole,
  MessageAttachment,
  AgentFile,
} from '../types';

interface AgentDocument {
  _id?: ObjectId;
  organizationId?: string;
  userId: string;
  phone?: string;
  name: string;
  description?: string;
  instructions: string;
  provider: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  files: AgentFile[];
  metadata?: Record<string, any>;
}

interface ThreadDocument {
  _id?: ObjectId;
  organizationId?: string;
  agentId: string;
  userId: string;
  endUserId?: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    _id?: ObjectId;
    role: MessageRole;
    content: string;
    timestamp: Date;
    metadata?: Record<string, any>;
    attachments?: MessageAttachment[];
  }>;
  isPendingThread: boolean;
  metadata?: Record<string, any>;
}

export interface MongoDBStorageConfig {
  uri: string;
  dbName?: string;
  agentsCollection?: string;
  threadsCollection?: string;
}

/**
 * MongoDB Storage Adapter
 * Provides persistent storage for agents and threads using MongoDB
 */
export class MongoDBStorage implements StorageAdapter {
  private client: MongoClient;
  private db: Db | null = null;
  private config: Required<MongoDBStorageConfig>;

  constructor(config: MongoDBStorageConfig | string) {
    if (typeof config === 'string') {
      this.config = {
        uri: config,
        dbName: 'agentStudio',
        agentsCollection: 'v2_agents',
        threadsCollection: 'v2_threads',
      };
    } else {
      this.config = {
        uri: config.uri,
        dbName: config.dbName || 'agentStudio',
        agentsCollection: config.agentsCollection || 'v2_agents',
        threadsCollection: config.threadsCollection || 'v2_threads',
      };
    }

    this.client = new MongoClient(this.config.uri);
  }

  private async ensureConnection(): Promise<Db> {
    if (!this.db) {
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
    }
    return this.db;
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this.db = null;
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  async createAgent(config: AgentConfig): Promise<string> {
    const db = await this.ensureConnection();
    const collection: Collection<AgentDocument> = db.collection(
      this.config.agentsCollection
    );

    const doc: AgentDocument = {
      organizationId: config.organizationId,
      userId: config.userId,
      phone: config.phone,
      name: config.name,
      description: config.description,
      instructions: config.instructions,
      provider: config.provider,
      model: config.model,
      createdAt: new Date(),
      updatedAt: new Date(),
      files: [],
      metadata: config.metadata || {},
    };

    const result = await collection.insertOne(doc);
    return result.insertedId.toString();
  }

  async getAgent(agentId: string): Promise<AgentData | null> {
    const db = await this.ensureConnection();
    const collection: Collection<AgentDocument> = db.collection(
      this.config.agentsCollection
    );

    const doc = await collection.findOne({ _id: new ObjectId(agentId) });
    if (!doc) return null;

    return this.agentDocToData(doc);
  }

  async updateAgent(
    agentId: string,
    updates: Partial<AgentConfig>
  ): Promise<void> {
    const db = await this.ensureConnection();
    const collection: Collection<AgentDocument> = db.collection(
      this.config.agentsCollection
    );

    await collection.updateOne(
      { _id: new ObjectId(agentId) },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      }
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    const db = await this.ensureConnection();
    const collection: Collection<AgentDocument> = db.collection(
      this.config.agentsCollection
    );

    await collection.deleteOne({ _id: new ObjectId(agentId) });
  }

  async listAgents(
    userId: string,
    organizationId?: string
  ): Promise<AgentData[]> {
    const db = await this.ensureConnection();
    const collection: Collection<AgentDocument> = db.collection(
      this.config.agentsCollection
    );

    const query: any = { userId };
    if (organizationId) {
      query.organizationId = organizationId;
    }

    const docs = await collection.find(query).sort({ updatedAt: -1 }).toArray();
    return docs.map((doc) => this.agentDocToData(doc));
  }

  // ============================================================================
  // Thread Operations
  // ============================================================================

  async createThread(config: ThreadConfig): Promise<string> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    const doc: ThreadDocument = {
      organizationId: config.organizationId,
      agentId: config.agentId,
      userId: config.userId,
      endUserId: config.endUserId,
      name: config.name,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      isPendingThread: true,
      metadata: config.metadata || {},
    };

    const result = await collection.insertOne(doc);
    return result.insertedId.toString();
  }

  async getThread(threadId: string): Promise<ThreadData | null> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    const doc = await collection.findOne({ _id: new ObjectId(threadId) });
    if (!doc) return null;

    return this.threadDocToData(doc);
  }

  async updateThread(
    threadId: string,
    updates: Partial<ThreadConfig>
  ): Promise<void> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    await collection.updateOne(
      { _id: new ObjectId(threadId) },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      }
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    await collection.deleteOne({ _id: new ObjectId(threadId) });
  }

  async listThreads(filters: {
    userId?: string;
    agentId?: string;
    organizationId?: string;
  }): Promise<ThreadData[]> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    const query: any = {};
    if (filters.userId) query.userId = filters.userId;
    if (filters.agentId) query.agentId = filters.agentId;
    if (filters.organizationId) query.organizationId = filters.organizationId;

    const docs = await collection.find(query).sort({ updatedAt: -1 }).toArray();
    return docs.map((doc) => this.threadDocToData(doc));
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
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    const messageId = new ObjectId();
    const message = {
      _id: messageId,
      role,
      content,
      timestamp: new Date(),
      attachments,
    };

    await collection.updateOne(
      { _id: new ObjectId(threadId) },
      {
        $push: { messages: message },
        $set: { updatedAt: new Date() },
      }
    );

    return messageId.toString();
  }

  async getMessages(threadId: string, limit?: number): Promise<MessageData[]> {
    const db = await this.ensureConnection();
    const collection: Collection<ThreadDocument> = db.collection(
      this.config.threadsCollection
    );

    const doc = await collection.findOne({ _id: new ObjectId(threadId) });
    if (!doc) return [];

    let messages = doc.messages.map((msg) => ({
      id: msg._id?.toString() || '',
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      metadata: msg.metadata,
      attachments: msg.attachments,
    }));

    if (limit) {
      messages = messages.slice(-limit);
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

  private agentDocToData(doc: AgentDocument): AgentData {
    return {
      id: doc._id!.toString(),
      organizationId: doc.organizationId,
      userId: doc.userId,
      phone: doc.phone,
      name: doc.name,
      description: doc.description,
      instructions: doc.instructions,
      provider: doc.provider as any,
      model: doc.model,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      files: doc.files,
      metadata: doc.metadata,
    };
  }

  private threadDocToData(doc: ThreadDocument): ThreadData {
    return {
      id: doc._id!.toString(),
      organizationId: doc.organizationId,
      agentId: doc.agentId,
      userId: doc.userId,
      endUserId: doc.endUserId,
      name: doc.name,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      messages: doc.messages.map((msg) => ({
        id: msg._id?.toString() || '',
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
        attachments: msg.attachments,
      })),
      isPendingThread: doc.isPendingThread,
      metadata: doc.metadata,
    };
  }
}

