import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleAnalytics } from '../src/ConsoleAnalytics';

describe('ConsoleAnalytics', () => {
  let analytics: ConsoleAnalytics;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    analytics?.destroy();
    consoleSpy.mockRestore();
  });

  // ============================================================================
  // Constructor & Configuration
  // ============================================================================

  describe('constructor', () => {
    it('should create analytics with default config', () => {
      analytics = new ConsoleAnalytics();

      expect(analytics.name).toBe('console-analytics');
      expect(analytics.type).toBe('analytics');
    });

    it('should accept custom config', () => {
      analytics = new ConsoleAnalytics({
        level: 'verbose',
        colors: false,
        timestamps: false,
        prefix: '[Test]',
      });

      expect(analytics.name).toBe('console-analytics');
    });

    it('should start summary timer when interval is set', () => {
      analytics = new ConsoleAnalytics({
        summaryInterval: 1000,
      });

      expect(analytics.name).toBe('console-analytics');
      // Timer will be cleaned up in afterEach
    });
  });

  // ============================================================================
  // trackRequest
  // ============================================================================

  describe('trackRequest', () => {
    beforeEach(() => {
      analytics = new ConsoleAnalytics();
    });

    it('should track request and increment counter', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      const stats = analytics.getStats();
      expect(stats.requests).toBe(1);
    });

    it('should log request to console', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('Request');
    });

    it('should not log when logRequests is false', async () => {
      analytics = new ConsoleAnalytics({ logRequests: false });

      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should show message in verbose mode', async () => {
      analytics = new ConsoleAnalytics({ level: 'verbose' });

      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Test message content',
        timestamp: new Date(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('Message:');
    });
  });

  // ============================================================================
  // trackResponse
  // ============================================================================

  describe('trackResponse', () => {
    beforeEach(() => {
      analytics = new ConsoleAnalytics();
    });

    it('should track response and increment counter', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Hello back',
        latency: 500,
        tokensUsed: 100,
        timestamp: new Date(),
      });

      const stats = analytics.getStats();
      expect(stats.responses).toBe(1);
    });

    it('should accumulate latency', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'R1',
        latency: 200,
        timestamp: new Date(),
      });

      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'R2',
        latency: 400,
        timestamp: new Date(),
      });

      const stats = analytics.getStats();
      expect(stats.avgLatency).toBe(300);
    });

    it('should accumulate tokens', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'R1',
        latency: 100,
        tokensUsed: 50,
        timestamp: new Date(),
      });

      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'R2',
        latency: 100,
        tokensUsed: 150,
        timestamp: new Date(),
      });

      const stats = analytics.getStats();
      expect(stats.totalTokens).toBe(200);
    });

    it('should log response to console', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Hello',
        latency: 500,
        timestamp: new Date(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('Response');
      expect(logCall).toContain('500ms');
    });

    it('should not log when logResponses is false', async () => {
      analytics = new ConsoleAnalytics({ logResponses: false });

      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Hello',
        latency: 500,
        timestamp: new Date(),
      });

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // trackError
  // ============================================================================

  describe('trackError', () => {
    beforeEach(() => {
      analytics = new ConsoleAnalytics();
    });

    it('should track error and increment counter', async () => {
      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'timeout',
        errorMessage: 'Request timed out',
      });

      const stats = analytics.getStats();
      expect(stats.errors).toBe(1);
    });

    it('should log error to console', async () => {
      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'api_error',
        errorMessage: 'Rate limit exceeded',
      });

      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('Error');
      expect(logCall).toContain('api_error');
    });

    it('should not log when logErrors is false', async () => {
      analytics = new ConsoleAnalytics({ logErrors: false });

      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'error',
        errorMessage: 'Some error',
      });

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // getStats
  // ============================================================================

  describe('getStats', () => {
    it('should return zero stats initially', () => {
      analytics = new ConsoleAnalytics();

      const stats = analytics.getStats();

      expect(stats.requests).toBe(0);
      expect(stats.responses).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.avgLatency).toBe(0);
      expect(stats.totalTokens).toBe(0);
    });

    it('should calculate average latency correctly', async () => {
      analytics = new ConsoleAnalytics({ logResponses: false });

      await analytics.trackResponse({
        agentId: 'a',
        response: 'r',
        latency: 100,
        timestamp: new Date(),
      });
      await analytics.trackResponse({
        agentId: 'a',
        response: 'r',
        latency: 300,
        timestamp: new Date(),
      });
      await analytics.trackResponse({
        agentId: 'a',
        response: 'r',
        latency: 500,
        timestamp: new Date(),
      });

      const stats = analytics.getStats();
      expect(stats.avgLatency).toBe(300);
    });
  });

  // ============================================================================
  // reset
  // ============================================================================

  describe('reset', () => {
    it('should reset all counters', async () => {
      analytics = new ConsoleAnalytics({ logRequests: false, logResponses: false });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date(),
      });
      await analytics.trackResponse({
        agentId: 'a',
        response: 'r',
        latency: 100,
        tokensUsed: 50,
        timestamp: new Date(),
      });

      analytics.reset();

      const stats = analytics.getStats();
      expect(stats.requests).toBe(0);
      expect(stats.responses).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.totalTokens).toBe(0);
    });
  });

  // ============================================================================
  // printSummary
  // ============================================================================

  describe('printSummary', () => {
    it('should print summary to console', async () => {
      analytics = new ConsoleAnalytics({ logResponses: false });

      await analytics.trackResponse({
        agentId: 'a',
        response: 'r',
        latency: 250,
        tokensUsed: 100,
        timestamp: new Date(),
      });

      analytics.printSummary();

      expect(consoleSpy).toHaveBeenCalled();
      // Check for summary content
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('Summary');
    });
  });

  // ============================================================================
  // Log Levels
  // ============================================================================

  describe('log levels', () => {
    it('should show minimal info in minimal mode', async () => {
      analytics = new ConsoleAnalytics({ level: 'minimal' });

      await analytics.trackRequest({
        agentId: 'agent-123456789',
        message: 'Hello world',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      // Minimal mode should not include agent ID prefix
      expect(logCall).not.toContain('agent:');
    });

    it('should show agent info in standard mode', async () => {
      analytics = new ConsoleAnalytics({ level: 'standard' });

      await analytics.trackRequest({
        agentId: 'agent-123456789',
        message: 'Hello world',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('agent:');
    });

    it('should show message content in verbose mode', async () => {
      analytics = new ConsoleAnalytics({ level: 'verbose' });

      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'My test message',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('Message:');
      expect(logCall).toContain('My test message');
    });
  });

  // ============================================================================
  // Colors and Formatting
  // ============================================================================

  describe('colors and formatting', () => {
    it('should use ANSI colors when enabled', async () => {
      analytics = new ConsoleAnalytics({ colors: true });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      // Should contain ANSI escape codes
      expect(logCall).toContain('\x1b[');
    });

    it('should not use ANSI colors when disabled', async () => {
      analytics = new ConsoleAnalytics({ colors: false });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      // Should not contain ANSI escape codes
      expect(logCall).not.toContain('\x1b[');
    });

    it('should include timestamp when enabled', async () => {
      analytics = new ConsoleAnalytics({ timestamps: true, colors: false });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date('2024-01-15T12:30:45.123Z'),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('12:30:45');
    });

    it('should not include timestamp when disabled', async () => {
      analytics = new ConsoleAnalytics({ timestamps: false, colors: false });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date('2024-01-15T12:30:45.123Z'),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).not.toContain('12:30:45');
    });

    it('should use custom prefix', async () => {
      analytics = new ConsoleAnalytics({ prefix: '[MyApp]', colors: false });

      await analytics.trackRequest({
        agentId: 'a',
        message: 'm',
        timestamp: new Date(),
      });

      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('[MyApp]');
    });
  });

  // ============================================================================
  // destroy
  // ============================================================================

  describe('destroy', () => {
    it('should clean up resources', () => {
      analytics = new ConsoleAnalytics({ summaryInterval: 1000 });

      // Should not throw
      expect(() => analytics.destroy()).not.toThrow();
    });
  });
});

