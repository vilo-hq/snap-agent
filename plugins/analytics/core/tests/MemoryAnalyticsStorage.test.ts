import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAnalyticsStorage } from '../src/storage/MemoryAnalyticsStorage';
import type { StoredRequest, StoredResponse, StoredError } from '../src/storage/AnalyticsStorage';

describe('MemoryAnalyticsStorage', () => {
  let storage: MemoryAnalyticsStorage;

  beforeEach(() => {
    storage = new MemoryAnalyticsStorage();
  });

  const createRequest = (id: string, agentId = 'agent-1'): StoredRequest => ({
    id,
    agentId,
    threadId: 'thread-1',
    userId: 'user-1',
    timestamp: new Date(),
    messageLength: 50,
    model: 'gpt-4o',
    provider: 'openai',
  });

  const createResponse = (id: string, agentId = 'agent-1'): StoredResponse => ({
    id,
    requestId: `req-${id}`,
    agentId,
    threadId: 'thread-1',
    userId: 'user-1',
    timestamp: new Date(),
    responseLength: 100,
    timings: { total: 250 },
    tokens: {
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
    },
    success: true,
    model: 'gpt-4o',
    provider: 'openai',
  });

  const createError = (id: string, agentId = 'agent-1'): StoredError => ({
    id,
    agentId,
    threadId: 'thread-1',
    timestamp: new Date(),
    errorType: 'timeout',
    errorMessage: 'Request timed out',
    component: 'llm',
  });

  // ==========================================================================
  // Basic Operations
  // ==========================================================================

  describe('saveRequests', () => {
    it('should save requests', async () => {
      const requests = [createRequest('req-1'), createRequest('req-2')];
      await storage.saveRequests(requests);

      const stored = await storage.getRequests();
      expect(stored.length).toBe(2);
    });

    it('should handle empty array', async () => {
      await storage.saveRequests([]);
      const stored = await storage.getRequests();
      expect(stored.length).toBe(0);
    });
  });

  describe('saveResponses', () => {
    it('should save responses', async () => {
      const responses = [createResponse('res-1'), createResponse('res-2')];
      await storage.saveResponses(responses);

      const stored = await storage.getResponses();
      expect(stored.length).toBe(2);
    });
  });

  describe('saveErrors', () => {
    it('should save errors', async () => {
      const errors = [createError('err-1')];
      await storage.saveErrors(errors);

      const stored = await storage.getErrors();
      expect(stored.length).toBe(1);
    });
  });

  // ==========================================================================
  // Query Options
  // ==========================================================================

  describe('getRequests with options', () => {
    beforeEach(async () => {
      await storage.saveRequests([
        { ...createRequest('req-1'), agentId: 'agent-1' },
        { ...createRequest('req-2'), agentId: 'agent-2' },
        { ...createRequest('req-3'), agentId: 'agent-1' },
      ]);
    });

    it('should filter by agentId', async () => {
      const requests = await storage.getRequests({ agentId: 'agent-1' });
      expect(requests.length).toBe(2);
      expect(requests.every((r) => r.agentId === 'agent-1')).toBe(true);
    });

    it('should apply limit', async () => {
      const requests = await storage.getRequests({ limit: 2 });
      expect(requests.length).toBe(2);
    });

    it('should apply offset', async () => {
      const requests = await storage.getRequests({ offset: 1 });
      expect(requests.length).toBe(2);
    });

    it('should filter by date range', async () => {
      const oldDate = new Date('2024-01-01');
      const newDate = new Date('2024-06-01');
      
      await storage.saveRequests([
        { ...createRequest('req-old'), timestamp: oldDate },
        { ...createRequest('req-new'), timestamp: newDate },
      ]);

      const requests = await storage.getRequests({
        startDate: new Date('2024-05-01'),
        endDate: new Date('2024-07-01'),
      });

      expect(requests.length).toBe(1);
    });
  });

  describe('getResponses with options', () => {
    beforeEach(async () => {
      await storage.saveResponses([
        { ...createResponse('res-1'), userId: 'user-1' },
        { ...createResponse('res-2'), userId: 'user-2' },
      ]);
    });

    it('should filter by userId', async () => {
      const responses = await storage.getResponses({ userId: 'user-1' });
      expect(responses.length).toBe(1);
    });
  });

  describe('getErrors with options', () => {
    beforeEach(async () => {
      await storage.saveErrors([
        { ...createError('err-1'), threadId: 'thread-1' },
        { ...createError('err-2'), threadId: 'thread-2' },
      ]);
    });

    it('should filter by threadId', async () => {
      const errors = await storage.getErrors({ threadId: 'thread-1' });
      expect(errors.length).toBe(1);
    });
  });

  // ==========================================================================
  // Count Methods
  // ==========================================================================

  describe('getRequestCount', () => {
    it('should return total request count', async () => {
      await storage.saveRequests([createRequest('req-1'), createRequest('req-2')]);
      const count = await storage.getRequestCount();
      expect(count).toBe(2);
    });

    it('should filter by agentId', async () => {
      await storage.saveRequests([
        { ...createRequest('req-1'), agentId: 'agent-1' },
        { ...createRequest('req-2'), agentId: 'agent-2' },
      ]);
      const count = await storage.getRequestCount({ agentId: 'agent-1' });
      expect(count).toBe(1);
    });
  });

  describe('getResponseCount', () => {
    it('should return total response count', async () => {
      await storage.saveResponses([createResponse('res-1')]);
      const count = await storage.getResponseCount();
      expect(count).toBe(1);
    });
  });

  describe('getErrorCount', () => {
    it('should return total error count', async () => {
      await storage.saveErrors([createError('err-1'), createError('err-2')]);
      const count = await storage.getErrorCount();
      expect(count).toBe(2);
    });
  });

  // ==========================================================================
  // Delete Operations
  // ==========================================================================

  describe('deleteOlderThan', () => {
    it('should delete old records', async () => {
      const oldDate = new Date('2024-01-01');
      const newDate = new Date();

      await storage.saveRequests([
        { ...createRequest('req-old'), timestamp: oldDate },
        { ...createRequest('req-new'), timestamp: newDate },
      ]);

      await storage.saveResponses([
        { ...createResponse('res-old'), timestamp: oldDate },
        { ...createResponse('res-new'), timestamp: newDate },
      ]);

      await storage.saveErrors([
        { ...createError('err-old'), timestamp: oldDate },
        { ...createError('err-new'), timestamp: newDate },
      ]);

      const cutoff = new Date('2024-06-01');
      const result = await storage.deleteOlderThan(cutoff);

      expect(result.requests).toBe(1);
      expect(result.responses).toBe(1);
      expect(result.errors).toBe(1);

      const requests = await storage.getRequests();
      expect(requests.length).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      await storage.saveRequests([createRequest('req-1')]);
      await storage.saveResponses([createResponse('res-1')]);
      await storage.saveErrors([createError('err-1')]);

      await storage.clear();

      expect(await storage.getRequestCount()).toBe(0);
      expect(await storage.getResponseCount()).toBe(0);
      expect(await storage.getErrorCount()).toBe(0);
    });
  });

  // ==========================================================================
  // Connection Methods
  // ==========================================================================

  describe('isReady', () => {
    it('should return true for memory storage', async () => {
      const ready = await storage.isReady();
      expect(ready).toBe(true);
    });
  });

  describe('close', () => {
    it('should be a no-op for memory storage', async () => {
      await expect(storage.close()).resolves.not.toThrow();
    });
  });
});

