import type {
  AnalyticsStorage,
  StoredRequest,
  StoredResponse,
  StoredError,
  AnalyticsQueryOptions,
  AggregationOptions,
} from './AnalyticsStorage';

/**
 * In-memory analytics storage implementation.
 * Suitable for development, testing, or short-lived processes.
 * Data is lost when the process terminates.
 */
export class MemoryAnalyticsStorage implements AnalyticsStorage {
  private requests: StoredRequest[] = [];
  private responses: StoredResponse[] = [];
  private errors: StoredError[] = [];

  async saveRequests(requests: StoredRequest[]): Promise<void> {
    this.requests.push(...requests);
  }

  async saveResponses(responses: StoredResponse[]): Promise<void> {
    this.responses.push(...responses);
  }

  async saveErrors(errors: StoredError[]): Promise<void> {
    this.errors.push(...errors);
  }

  async getRequests(options?: AnalyticsQueryOptions): Promise<StoredRequest[]> {
    return this.filterRecords(this.requests, options);
  }

  async getResponses(options?: AnalyticsQueryOptions): Promise<StoredResponse[]> {
    return this.filterRecords(this.responses, options);
  }

  async getErrors(options?: AnalyticsQueryOptions): Promise<StoredError[]> {
    return this.filterRecords(this.errors, options);
  }

  async getRequestCount(options?: AggregationOptions): Promise<number> {
    return this.filterRecords(this.requests, options).length;
  }

  async getResponseCount(options?: AggregationOptions): Promise<number> {
    return this.filterRecords(this.responses, options).length;
  }

  async getErrorCount(options?: AggregationOptions): Promise<number> {
    return this.filterRecords(this.errors, options).length;
  }

  async deleteOlderThan(date: Date): Promise<{ requests: number; responses: number; errors: number }> {
    const timestamp = date.getTime();

    const requestsBefore = this.requests.length;
    this.requests = this.requests.filter((r) => r.timestamp.getTime() >= timestamp);
    const requestsDeleted = requestsBefore - this.requests.length;

    const responsesBefore = this.responses.length;
    this.responses = this.responses.filter((r) => r.timestamp.getTime() >= timestamp);
    const responsesDeleted = responsesBefore - this.responses.length;

    const errorsBefore = this.errors.length;
    this.errors = this.errors.filter((e) => e.timestamp.getTime() >= timestamp);
    const errorsDeleted = errorsBefore - this.errors.length;

    return {
      requests: requestsDeleted,
      responses: responsesDeleted,
      errors: errorsDeleted,
    };
  }

  async clear(): Promise<void> {
    this.requests = [];
    this.responses = [];
    this.errors = [];
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No-op for memory storage
  }

  /**
   * Filter records based on query options
   */
  private filterRecords<T extends { agentId: string; threadId?: string; userId?: string; timestamp: Date }>(
    records: T[],
    options?: AnalyticsQueryOptions
  ): T[] {
    if (!options) {
      return [...records];
    }

    let filtered = records;

    if (options.agentId) {
      filtered = filtered.filter((r) => r.agentId === options.agentId);
    }

    if (options.threadId) {
      filtered = filtered.filter((r) => r.threadId === options.threadId);
    }

    if (options.userId) {
      filtered = filtered.filter((r) => r.userId === options.userId);
    }

    if (options.startDate) {
      const start = options.startDate.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() >= start);
    }

    if (options.endDate) {
      const end = options.endDate.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() <= end);
    }

    // Apply offset and limit
    if (options.offset) {
      filtered = filtered.slice(options.offset);
    }

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Get current storage stats (for debugging)
   */
  getStats(): { requests: number; responses: number; errors: number } {
    return {
      requests: this.requests.length,
      responses: this.responses.length,
      errors: this.errors.length,
    };
  }
}

