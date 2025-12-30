import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/RateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  // ============================================================================
  // Constructor & Configuration
  // ============================================================================

  describe('constructor', () => {
    it('should create limiter with default config', () => {
      limiter = new RateLimiter();

      expect(limiter.name).toBe('rate-limiter');
      expect(limiter.type).toBe('middleware');
      expect(limiter.priority).toBe(5);
    });

    it('should accept custom config', () => {
      limiter = new RateLimiter({
        maxRequests: 50,
        windowMs: 30000,
        keyBy: 'agentId',
        onLimit: 'queue',
      });

      expect(limiter.name).toBe('rate-limiter');
    });

    it('should handle custom key function', () => {
      limiter = new RateLimiter({
        keyBy: (context) => `custom:${context.agentId}`,
      });

      expect(limiter.name).toBe('rate-limiter');
    });
  });

  // ============================================================================
  // Rate Limiting
  // ============================================================================

  describe('rate limiting', () => {
    beforeEach(() => {
      limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 1000,
        keyBy: 'userId',
      });
    });

    it('should allow requests under the limit', async () => {
      const context = { agentId: 'agent-1', metadata: { userId: 'user-1' } };

      const result = await limiter.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        context
      );

      expect(result.metadata?.rateLimit?.allowed).toBe(true);
      expect(result.metadata?.rateLimit?.remaining).toBe(2);
    });

    it('should track multiple requests correctly', async () => {
      const context = { agentId: 'agent-1', metadata: { userId: 'user-1' } };

      // First request
      const r1 = await limiter.beforeRequest([], context);
      expect(r1.metadata?.rateLimit?.remaining).toBe(2);

      // Second request
      const r2 = await limiter.beforeRequest([], context);
      expect(r2.metadata?.rateLimit?.remaining).toBe(1);

      // Third request
      const r3 = await limiter.beforeRequest([], context);
      expect(r3.metadata?.rateLimit?.remaining).toBe(0);
    });

    it('should reject requests over the limit', async () => {
      const context = { agentId: 'agent-1', metadata: { userId: 'user-1' } };

      // Exhaust the limit
      await limiter.beforeRequest([], context);
      await limiter.beforeRequest([], context);
      await limiter.beforeRequest([], context);

      // Fourth request should be rejected
      const result = await limiter.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        context
      );

      expect(result.metadata?.rateLimit?.allowed).toBe(false);
      expect(result.metadata?._skipLLM).toBe(true);
      expect(result.messages[0].content).toContain('[RATE_LIMITED]');
    });

    it('should reset after window expires', async () => {
      limiter = new RateLimiter({
        maxRequests: 2,
        windowMs: 50, // 50ms window
        keyBy: 'userId',
      });

      const context = { agentId: 'agent-1', metadata: { userId: 'user-1' } };

      // Exhaust the limit
      await limiter.beforeRequest([], context);
      await limiter.beforeRequest([], context);

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 60));

      // Should be allowed again
      const result = await limiter.beforeRequest([], context);
      expect(result.metadata?.rateLimit?.allowed).toBe(true);
    });

    it('should track different users separately', async () => {
      const user1 = { agentId: 'agent-1', metadata: { userId: 'user-1' } };
      const user2 = { agentId: 'agent-1', metadata: { userId: 'user-2' } };

      // Exhaust user1's limit
      await limiter.beforeRequest([], user1);
      await limiter.beforeRequest([], user1);
      await limiter.beforeRequest([], user1);

      // User1 should be limited
      const r1 = await limiter.beforeRequest([], user1);
      expect(r1.metadata?.rateLimit?.allowed).toBe(false);

      // User2 should still be allowed
      const r2 = await limiter.beforeRequest([], user2);
      expect(r2.metadata?.rateLimit?.allowed).toBe(true);
    });
  });

  // ============================================================================
  // Key By Options
  // ============================================================================

  describe('keyBy options', () => {
    it('should key by userId', async () => {
      limiter = new RateLimiter({ maxRequests: 1, keyBy: 'userId' });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      await limiter.beforeRequest([], context);

      const r = await limiter.beforeRequest([], context);
      expect(r.metadata?.rateLimit?.allowed).toBe(false);
    });

    it('should key by threadId', async () => {
      limiter = new RateLimiter({ maxRequests: 1, keyBy: 'threadId' });

      const context1 = { agentId: 'a', threadId: 't1' };
      const context2 = { agentId: 'a', threadId: 't2' };

      await limiter.beforeRequest([], context1);

      // Same thread should be limited
      const r1 = await limiter.beforeRequest([], context1);
      expect(r1.metadata?.rateLimit?.allowed).toBe(false);

      // Different thread should be allowed
      const r2 = await limiter.beforeRequest([], context2);
      expect(r2.metadata?.rateLimit?.allowed).toBe(true);
    });

    it('should key by agentId', async () => {
      limiter = new RateLimiter({ maxRequests: 1, keyBy: 'agentId' });

      const context1 = { agentId: 'agent-1' };
      const context2 = { agentId: 'agent-2' };

      await limiter.beforeRequest([], context1);

      // Same agent should be limited
      const r1 = await limiter.beforeRequest([], context1);
      expect(r1.metadata?.rateLimit?.allowed).toBe(false);

      // Different agent should be allowed
      const r2 = await limiter.beforeRequest([], context2);
      expect(r2.metadata?.rateLimit?.allowed).toBe(true);
    });

    it('should key by ip', async () => {
      limiter = new RateLimiter({ maxRequests: 1, keyBy: 'ip' });

      const context = { agentId: 'a', metadata: { ip: '192.168.1.1' } };
      await limiter.beforeRequest([], context);

      const r = await limiter.beforeRequest([], context);
      expect(r.metadata?.rateLimit?.allowed).toBe(false);
    });

    it('should key globally', async () => {
      limiter = new RateLimiter({ maxRequests: 2, keyBy: 'global' });

      const context1 = { agentId: 'a1', metadata: { userId: 'u1' } };
      const context2 = { agentId: 'a2', metadata: { userId: 'u2' } };

      await limiter.beforeRequest([], context1);
      await limiter.beforeRequest([], context2);

      // Global limit reached - both users limited
      const r = await limiter.beforeRequest([], context1);
      expect(r.metadata?.rateLimit?.allowed).toBe(false);
    });

    it('should use custom key function', async () => {
      limiter = new RateLimiter({
        maxRequests: 2,
        keyBy: (context) => `org:${context.metadata?.orgId}`,
      });

      const context = { agentId: 'a', metadata: { orgId: 'org-1' } };
      
      // First request - should have key in metadata
      const r = await limiter.beforeRequest([], context);
      expect(r.metadata?.rateLimit?.key).toBe('org:org-1');
      expect(r.metadata?.rateLimit?.allowed).toBe(true);
    });
  });

  // ============================================================================
  // Skip Function
  // ============================================================================

  describe('skip function', () => {
    it('should skip rate limiting for matching conditions', async () => {
      limiter = new RateLimiter({
        maxRequests: 1,
        skip: (key, context) => context.metadata?.role === 'admin',
      });

      const adminContext = { agentId: 'a', metadata: { userId: 'admin', role: 'admin' } };
      const userContext = { agentId: 'a', metadata: { userId: 'user', role: 'user' } };

      // Admin should always be allowed
      await limiter.beforeRequest([], adminContext);
      const r1 = await limiter.beforeRequest([], adminContext);
      expect(r1.metadata?.rateLimit?.skipped).toBe(true);

      // User should be limited
      await limiter.beforeRequest([], userContext);
      const r2 = await limiter.beforeRequest([], userContext);
      expect(r2.metadata?.rateLimit?.allowed).toBe(false);
    });
  });

  // ============================================================================
  // Rate Limit Callback
  // ============================================================================

  describe('onRateLimited callback', () => {
    it('should call callback when rate limited', async () => {
      const onRateLimited = vi.fn();

      limiter = new RateLimiter({
        maxRequests: 1,
        onRateLimited,
      });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      await limiter.beforeRequest([], context);
      await limiter.beforeRequest([], context);

      expect(onRateLimited).toHaveBeenCalledOnce();
      expect(onRateLimited).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ allowed: false }),
        context
      );
    });
  });

  // ============================================================================
  // getUsage Method
  // ============================================================================

  describe('getUsage', () => {
    it('should return current usage for a key', async () => {
      limiter = new RateLimiter({ maxRequests: 5 });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      await limiter.beforeRequest([], context);
      await limiter.beforeRequest([], context);

      const usage = await limiter.getUsage('user:u1');

      expect(usage.limit).toBe(5);
      expect(usage.remaining).toBe(3);
      expect(usage.allowed).toBe(true);
    });

    it('should return full limit for unknown key', async () => {
      limiter = new RateLimiter({ maxRequests: 10 });

      const usage = await limiter.getUsage('user:unknown');

      expect(usage.limit).toBe(10);
      expect(usage.remaining).toBe(10);
      expect(usage.allowed).toBe(true);
    });
  });

  // ============================================================================
  // reset Method
  // ============================================================================

  describe('reset', () => {
    it('should reset rate limit for a key', async () => {
      limiter = new RateLimiter({ maxRequests: 1 });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      await limiter.beforeRequest([], context);

      // Should be limited
      let r = await limiter.beforeRequest([], context);
      expect(r.metadata?.rateLimit?.allowed).toBe(false);

      // Reset
      limiter.reset('user:u1');

      // Should be allowed again
      r = await limiter.beforeRequest([], context);
      expect(r.metadata?.rateLimit?.allowed).toBe(true);
    });
  });

  // ============================================================================
  // afterResponse
  // ============================================================================

  describe('afterResponse', () => {
    it('should return limit message when rate limited', async () => {
      limiter = new RateLimiter({
        maxRequests: 1,
        limitMessage: 'Custom limit message',
      });

      const context = {
        agentId: 'a',
        metadata: { _skipLLM: true },
      };

      const result = await limiter.afterResponse('original response', context);

      expect(result.response).toBe('Custom limit message');
      expect(result.metadata?.rateLimited).toBe(true);
    });

    it('should add rate limit headers when enabled', async () => {
      limiter = new RateLimiter({
        maxRequests: 10,
        includeHeaders: true,
      });

      const context = {
        agentId: 'a',
        metadata: {
          rateLimit: {
            limit: 10,
            remaining: 8,
            resetAt: new Date('2024-01-15T12:00:00Z'),
          },
        },
      };

      const result = await limiter.afterResponse('response', context);

      expect(result.metadata?.headers).toBeDefined();
      expect(result.metadata?.headers['X-RateLimit-Limit']).toBe(10);
      expect(result.metadata?.headers['X-RateLimit-Remaining']).toBe(8);
    });

    it('should not add headers when disabled', async () => {
      limiter = new RateLimiter({
        maxRequests: 10,
        includeHeaders: false,
      });

      const context = { agentId: 'a' };
      const result = await limiter.afterResponse('response', context);

      expect(result.metadata?.headers).toBeUndefined();
    });
  });

  // ============================================================================
  // Custom Storage
  // ============================================================================

  describe('custom storage', () => {
    it('should use custom storage adapter', async () => {
      const storage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        increment: vi.fn().mockResolvedValue({ count: 1, resetAt: Date.now() + 60000 }),
      };

      limiter = new RateLimiter({
        maxRequests: 10,
        storage,
      });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      await limiter.beforeRequest([], context);

      expect(storage.increment).toHaveBeenCalledWith('user:u1', 60000);
    });

    it('should respect storage count for rate limiting', async () => {
      const storage = {
        get: vi.fn(),
        set: vi.fn(),
        increment: vi.fn().mockResolvedValue({ count: 11, resetAt: Date.now() + 60000 }),
      };

      limiter = new RateLimiter({
        maxRequests: 10,
        storage,
      });

      const context = { agentId: 'a', metadata: { userId: 'u1' } };
      const result = await limiter.beforeRequest([], context);

      expect(result.metadata?.rateLimit?.allowed).toBe(false);
    });
  });

  // ============================================================================
  // destroy Method
  // ============================================================================

  describe('destroy', () => {
    it('should clean up resources', () => {
      limiter = new RateLimiter();
      
      // Should not throw
      expect(() => limiter.destroy()).not.toThrow();
    });
  });
});

