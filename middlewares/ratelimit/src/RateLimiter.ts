import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * How to identify rate limit buckets
 */
export type RateLimitKey = 
  | 'userId'      // Rate limit per user
  | 'threadId'    // Rate limit per thread
  | 'agentId'     // Rate limit per agent
  | 'ip'          // Rate limit per IP (requires metadata.ip)
  | 'global';     // Global rate limit

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfter?: number; // Seconds until retry
}

/**
 * Rate limit entry
 */
interface RateLimitEntry {
  count: number;
  resetAt: number; // Timestamp
}

/**
 * Configuration for rate limiter
 */
export interface RateLimitConfig {
  /**
   * Maximum requests allowed in the window
   * @default 100
   */
  maxRequests: number;

  /**
   * Time window in milliseconds
   * @default 60000 (1 minute)
   */
  windowMs: number;

  /**
   * How to identify rate limit buckets
   * @default 'userId'
   */
  keyBy: RateLimitKey | ((context: { agentId: string; threadId?: string; metadata?: any }) => string);

  /**
   * Action when rate limited
   * @default 'reject'
   */
  onLimit: 'reject' | 'queue' | 'throttle';

  /**
   * Message to return when rate limited
   * @default "Too many requests. Please try again later."
   */
  limitMessage?: string;

  /**
   * Include rate limit info in response metadata
   * @default true
   */
  includeHeaders?: boolean;

  /**
   * Skip rate limiting for certain keys (e.g., admin users)
   */
  skip?: (key: string, context: { agentId: string; threadId?: string; metadata?: any }) => boolean;

  /**
   * Callback when rate limit is hit
   */
  onRateLimited?: (key: string, result: RateLimitResult, context: {
    agentId: string;
    threadId?: string;
  }) => void;

  /**
   * Custom storage adapter (for distributed rate limiting)
   * Default uses in-memory storage
   */
  storage?: {
    get: (key: string) => Promise<RateLimitEntry | null>;
    set: (key: string, entry: RateLimitEntry, ttlMs: number) => Promise<void>;
    increment: (key: string, windowMs: number) => Promise<{ count: number; resetAt: number }>;
  };

  /**
   * Queue configuration (when onLimit is 'queue')
   */
  queue?: {
    maxSize: number;
    timeout: number; // Max time to wait in queue (ms)
  };
}

/**
 * Queued request
 */
interface QueuedRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  addedAt: number;
}

/**
 * Rate Limiter Middleware
 * 
 * Implements per-user, per-agent, or global rate limiting to prevent abuse
 * and control costs.
 * 
 * @example
 * ```typescript
 * import { RateLimiter } from '@snap-agent/middleware-ratelimit';
 * 
 * const rateLimiter = new RateLimiter({
 *   maxRequests: 100,
 *   windowMs: 60 * 1000, // 1 minute
 *   keyBy: 'userId',
 *   onLimit: 'reject',
 * });
 * ```
 */
export class RateLimiter implements MiddlewarePlugin {
  name = 'rate-limiter';
  type = 'middleware' as const;
  priority = 5; // Run very early

  private config: Required<Omit<RateLimitConfig, 'storage' | 'skip' | 'onRateLimited' | 'queue'>> &
    Pick<RateLimitConfig, 'storage' | 'skip' | 'onRateLimited' | 'queue'>;
  
  // In-memory storage
  private limits: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Queue for 'queue' mode
  private queues: Map<string, QueuedRequest[]> = new Map();
  private processing: Set<string> = new Set();

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxRequests: config.maxRequests ?? 100,
      windowMs: config.windowMs ?? 60000,
      keyBy: config.keyBy ?? 'userId',
      onLimit: config.onLimit ?? 'reject',
      limitMessage: config.limitMessage ?? 'Too many requests. Please try again later.',
      includeHeaders: config.includeHeaders !== false,
      skip: config.skip,
      onRateLimited: config.onRateLimited,
      storage: config.storage,
      queue: config.queue,
    };

    // Start cleanup interval for in-memory storage
    if (!this.config.storage) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }
  }

  async beforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ messages: any[]; metadata?: any }> {
    const key = this.getKey(context);

    // Check if should skip
    if (this.config.skip?.(key, context)) {
      return { messages, metadata: { rateLimit: { skipped: true } } };
    }

    const result = await this.checkLimit(key);

    if (!result.allowed) {
      this.config.onRateLimited?.(key, result, context);

      if (this.config.onLimit === 'reject') {
        // Replace message with rate limit message
        const limitedMessage = { 
          role: 'system', 
          content: `[RATE_LIMITED] ${this.config.limitMessage}` 
        };
        
        return {
          messages: [limitedMessage],
          metadata: {
            rateLimit: {
              limited: true,
              ...result,
            },
            _skipLLM: true, // Signal to skip LLM call
          },
        };
      }

      if (this.config.onLimit === 'queue') {
        // Add to queue and wait
        await this.enqueue(key);
        // After dequeue, re-check and proceed
      }

      // For 'throttle', we continue but could add delay
    }

    return {
      messages,
      metadata: {
        rateLimit: {
          ...result,
          key,
        },
      },
    };
  }

  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    // Check if request was rate limited and should return limit message
    if (context.metadata?._skipLLM) {
      return {
        response: this.config.limitMessage,
        metadata: {
          ...context.metadata,
          rateLimited: true,
        },
      };
    }

    // Process next item in queue if applicable
    const key = this.getKey(context);
    this.processQueue(key);

    // Add rate limit headers to metadata if enabled
    if (this.config.includeHeaders && context.metadata?.rateLimit) {
      return {
        response,
        metadata: {
          ...context.metadata,
          headers: {
            'X-RateLimit-Limit': context.metadata.rateLimit.limit,
            'X-RateLimit-Remaining': context.metadata.rateLimit.remaining,
            'X-RateLimit-Reset': context.metadata.rateLimit.resetAt?.toISOString(),
          },
        },
      };
    }

    return { response, metadata: context.metadata };
  }

  /**
   * Get the rate limit key for a context
   */
  private getKey(context: { agentId: string; threadId?: string; metadata?: any }): string {
    if (typeof this.config.keyBy === 'function') {
      return this.config.keyBy(context);
    }

    switch (this.config.keyBy) {
      case 'userId':
        return `user:${context.metadata?.userId || 'anonymous'}`;
      case 'threadId':
        return `thread:${context.threadId || 'unknown'}`;
      case 'agentId':
        return `agent:${context.agentId}`;
      case 'ip':
        return `ip:${context.metadata?.ip || 'unknown'}`;
      case 'global':
        return 'global';
      default:
        return `user:${context.metadata?.userId || 'anonymous'}`;
    }
  }

  /**
   * Check and increment rate limit
   */
  private async checkLimit(key: string): Promise<RateLimitResult> {
    const now = Date.now();

    // Use custom storage if provided
    if (this.config.storage) {
      const { count, resetAt } = await this.config.storage.increment(key, this.config.windowMs);
      const allowed = count <= this.config.maxRequests;
      
      return {
        allowed,
        limit: this.config.maxRequests,
        remaining: Math.max(0, this.config.maxRequests - count),
        resetAt: new Date(resetAt),
        retryAfter: allowed ? undefined : Math.ceil((resetAt - now) / 1000),
      };
    }

    // In-memory storage
    let entry = this.limits.get(key);

    if (!entry || now > entry.resetAt) {
      // New window
      entry = {
        count: 1,
        resetAt: now + this.config.windowMs,
      };
      this.limits.set(key, entry);
    } else {
      // Increment in current window
      entry.count++;
    }

    const allowed = entry.count <= this.config.maxRequests;

    return {
      allowed,
      limit: this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt: new Date(entry.resetAt),
      retryAfter: allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  /**
   * Add request to queue
   */
  private enqueue(key: string): Promise<void> {
    const queue = this.queues.get(key) || [];
    const maxSize = this.config.queue?.maxSize || 10;
    const timeout = this.config.queue?.timeout || 30000;

    if (queue.length >= maxSize) {
      return Promise.reject(new Error('Rate limit queue is full'));
    }

    return new Promise((resolve, reject) => {
      queue.push({
        resolve,
        reject,
        addedAt: Date.now(),
      });
      this.queues.set(key, queue);

      // Set timeout
      setTimeout(() => {
        const idx = queue.findIndex((q) => q.resolve === resolve);
        if (idx > -1) {
          queue.splice(idx, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeout);

      // Start processing if not already
      this.processQueue(key);
    });
  }

  /**
   * Process queue for a key
   */
  private processQueue(key: string): void {
    if (this.processing.has(key)) return;

    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    this.processing.add(key);

    // Check if we can process
    const entry = this.limits.get(key);
    const now = Date.now();

    if (!entry || now > entry.resetAt || entry.count < this.config.maxRequests) {
      const item = queue.shift();
      if (item) {
        item.resolve(undefined);
      }
    }

    this.processing.delete(key);

    // Schedule next check
    if (queue.length > 0) {
      const waitTime = entry ? Math.max(0, entry.resetAt - now) : 0;
      setTimeout(() => this.processQueue(key), Math.min(waitTime, 1000));
    }
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.limits.entries()) {
      if (now > entry.resetAt) {
        this.limits.delete(key);
      }
    }
  }

  /**
   * Get current usage for a key
   */
  async getUsage(key: string): Promise<RateLimitResult> {
    if (this.config.storage) {
      const entry = await this.config.storage.get(key);
      if (!entry) {
        return {
          allowed: true,
          limit: this.config.maxRequests,
          remaining: this.config.maxRequests,
          resetAt: new Date(),
        };
      }
      return {
        allowed: entry.count < this.config.maxRequests,
        limit: this.config.maxRequests,
        remaining: Math.max(0, this.config.maxRequests - entry.count),
        resetAt: new Date(entry.resetAt),
      };
    }

    const entry = this.limits.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      return {
        allowed: true,
        limit: this.config.maxRequests,
        remaining: this.config.maxRequests,
        resetAt: new Date(),
      };
    }

    return {
      allowed: entry.count < this.config.maxRequests,
      limit: this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt: new Date(entry.resetAt),
    };
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.limits.delete(key);
  }

  /**
   * Destroy the rate limiter
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.limits.clear();
    this.queues.clear();
  }
}

