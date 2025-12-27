import type { Collection, Db, MongoClient } from 'mongodb';
import type {
  AnalyticsStorage,
  StoredRequest,
  StoredResponse,
  StoredError,
  AnalyticsQueryOptions,
  AggregationOptions,
} from './AnalyticsStorage';

export interface MongoAnalyticsStorageConfig {
  /**
   * MongoDB connection URI
   */
  uri: string;

  /**
   * Database name
   * @default 'snap-agent-analytics'
   */
  database?: string;

  /**
   * Collection prefix
   * @default 'analytics'
   */
  collectionPrefix?: string;

  /**
   * Create indexes on first connection
   * @default true
   */
  createIndexes?: boolean;
}

/**
 * MongoDB analytics storage implementation.
 * Provides persistent storage with efficient querying and aggregation.
 */
export class MongoAnalyticsStorage implements AnalyticsStorage {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private requestsCollection: Collection<StoredRequest> | null = null;
  private responsesCollection: Collection<StoredResponse> | null = null;
  private errorsCollection: Collection<StoredError> | null = null;

  private readonly config: Required<MongoAnalyticsStorageConfig>;
  private connectionPromise: Promise<void> | null = null;

  constructor(config: MongoAnalyticsStorageConfig) {
    this.config = {
      uri: config.uri,
      database: config.database || 'snap-agent-analytics',
      collectionPrefix: config.collectionPrefix || 'analytics',
      createIndexes: config.createIndexes !== false,
    };
  }

  /**
   * Ensure connection to MongoDB
   */
  private async ensureConnection(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    return this.connectionPromise;
  }

  private async connect(): Promise<void> {
    const { MongoClient } = await import('mongodb');

    this.client = new MongoClient(this.config.uri);
    await this.client.connect();

    this.db = this.client.db(this.config.database);

    const prefix = this.config.collectionPrefix;
    this.requestsCollection = this.db.collection<StoredRequest>(`${prefix}_requests`);
    this.responsesCollection = this.db.collection<StoredResponse>(`${prefix}_responses`);
    this.errorsCollection = this.db.collection<StoredError>(`${prefix}_errors`);

    if (this.config.createIndexes) {
      await this.createIndexes();
    }
  }

  private async createIndexes(): Promise<void> {
    if (!this.requestsCollection || !this.responsesCollection || !this.errorsCollection) {
      return;
    }

    // Request indexes
    await this.requestsCollection.createIndexes([
      { key: { agentId: 1, timestamp: -1 } },
      { key: { threadId: 1, timestamp: -1 } },
      { key: { userId: 1, timestamp: -1 } },
      { key: { timestamp: -1 } },
    ]);

    // Response indexes
    await this.responsesCollection.createIndexes([
      { key: { agentId: 1, timestamp: -1 } },
      { key: { threadId: 1, timestamp: -1 } },
      { key: { userId: 1, timestamp: -1 } },
      { key: { timestamp: -1 } },
      { key: { success: 1, timestamp: -1 } },
    ]);

    // Error indexes
    await this.errorsCollection.createIndexes([
      { key: { agentId: 1, timestamp: -1 } },
      { key: { errorType: 1, timestamp: -1 } },
      { key: { timestamp: -1 } },
    ]);
  }

  async saveRequests(requests: StoredRequest[]): Promise<void> {
    if (requests.length === 0) return;
    await this.ensureConnection();
    await this.requestsCollection!.insertMany(requests);
  }

  async saveResponses(responses: StoredResponse[]): Promise<void> {
    if (responses.length === 0) return;
    await this.ensureConnection();
    await this.responsesCollection!.insertMany(responses);
  }

  async saveErrors(errors: StoredError[]): Promise<void> {
    if (errors.length === 0) return;
    await this.ensureConnection();
    await this.errorsCollection!.insertMany(errors);
  }

  async getRequests(options?: AnalyticsQueryOptions): Promise<StoredRequest[]> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    let cursor = this.requestsCollection!.find(query).sort({ timestamp: -1 });

    if (options?.offset) {
      cursor = cursor.skip(options.offset);
    }
    if (options?.limit) {
      cursor = cursor.limit(options.limit);
    }

    return cursor.toArray();
  }

  async getResponses(options?: AnalyticsQueryOptions): Promise<StoredResponse[]> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    let cursor = this.responsesCollection!.find(query).sort({ timestamp: -1 });

    if (options?.offset) {
      cursor = cursor.skip(options.offset);
    }
    if (options?.limit) {
      cursor = cursor.limit(options.limit);
    }

    return cursor.toArray();
  }

  async getErrors(options?: AnalyticsQueryOptions): Promise<StoredError[]> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    let cursor = this.errorsCollection!.find(query).sort({ timestamp: -1 });

    if (options?.offset) {
      cursor = cursor.skip(options.offset);
    }
    if (options?.limit) {
      cursor = cursor.limit(options.limit);
    }

    return cursor.toArray();
  }

  async getRequestCount(options?: AggregationOptions): Promise<number> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    return this.requestsCollection!.countDocuments(query);
  }

  async getResponseCount(options?: AggregationOptions): Promise<number> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    return this.responsesCollection!.countDocuments(query);
  }

  async getErrorCount(options?: AggregationOptions): Promise<number> {
    await this.ensureConnection();
    const query = this.buildQuery(options);
    return this.errorsCollection!.countDocuments(query);
  }

  async deleteOlderThan(date: Date): Promise<{ requests: number; responses: number; errors: number }> {
    await this.ensureConnection();

    const query = { timestamp: { $lt: date } };

    const [requestsResult, responsesResult, errorsResult] = await Promise.all([
      this.requestsCollection!.deleteMany(query),
      this.responsesCollection!.deleteMany(query),
      this.errorsCollection!.deleteMany(query),
    ]);

    return {
      requests: requestsResult.deletedCount,
      responses: responsesResult.deletedCount,
      errors: errorsResult.deletedCount,
    };
  }

  async clear(): Promise<void> {
    await this.ensureConnection();

    await Promise.all([
      this.requestsCollection!.deleteMany({}),
      this.responsesCollection!.deleteMany({}),
      this.errorsCollection!.deleteMany({}),
    ]);
  }

  async isReady(): Promise<boolean> {
    try {
      await this.ensureConnection();
      await this.db!.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.requestsCollection = null;
      this.responsesCollection = null;
      this.errorsCollection = null;
      this.connectionPromise = null;
    }
  }

  /**
   * Build MongoDB query from options
   */
  private buildQuery(options?: AnalyticsQueryOptions): Record<string, any> {
    if (!options) {
      return {};
    }

    const query: Record<string, any> = {};

    if (options.agentId) {
      query.agentId = options.agentId;
    }

    if (options.threadId) {
      query.threadId = options.threadId;
    }

    if (options.userId) {
      query.userId = options.userId;
    }

    if (options.startDate || options.endDate) {
      query.timestamp = {};
      if (options.startDate) {
        query.timestamp.$gte = options.startDate;
      }
      if (options.endDate) {
        query.timestamp.$lte = options.endDate;
      }
    }

    return query;
  }

  /**
   * Get aggregated metrics with grouping by time period
   */
  async getAggregatedMetrics(options?: AggregationOptions): Promise<{
    totalRequests: number;
    totalResponses: number;
    totalErrors: number;
    avgLatency: number;
    totalTokens: number;
    errorRate: number;
  }> {
    await this.ensureConnection();

    const query = this.buildQuery(options);

    const [requestCount, responseStats, errorCount] = await Promise.all([
      this.requestsCollection!.countDocuments(query),
      this.responsesCollection!
        .aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              avgLatency: { $avg: '$timings.total' },
              totalTokens: { $sum: '$tokens.totalTokens' },
            },
          },
        ])
        .toArray(),
      this.errorsCollection!.countDocuments(query),
    ]);

    const stats = responseStats[0] || { count: 0, avgLatency: 0, totalTokens: 0 };

    return {
      totalRequests: requestCount,
      totalResponses: stats.count,
      totalErrors: errorCount,
      avgLatency: stats.avgLatency || 0,
      totalTokens: stats.totalTokens || 0,
      errorRate: stats.count > 0 ? errorCount / stats.count : 0,
    };
  }
}

