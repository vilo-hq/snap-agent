import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * How to track budget
 */
export type BudgetKey = 
  | 'userId'
  | 'organizationId'
  | 'agentId'
  | 'global';

/**
 * Current budget status
 */
export interface BudgetStatus {
  key: string;
  tokensUsed: number;
  tokensLimit: number;
  tokensRemaining: number;
  costUsed: number;
  costLimit: number;
  costRemaining: number;
  percentUsed: number;
  resetAt: Date;
  isExceeded: boolean;
}

/**
 * Budget entry for storage
 */
interface BudgetEntry {
  tokensUsed: number;
  costUsed: number;
  resetAt: number; // Timestamp
  requests: number;
}

/**
 * Model cost configuration (per 1K tokens)
 */
interface ModelCosts {
  [model: string]: {
    input: number;
    output: number;
  };
}

/**
 * Default model costs (per 1K tokens, USD)
 */
const DEFAULT_MODEL_COSTS: ModelCosts = {
  // OpenAI
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  // Anthropic
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
  // Google
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
};

/**
 * Configuration for token budget
 */
export interface TokenBudgetConfig {
  /**
   * Maximum tokens per request
   */
  maxTokensPerRequest?: number;

  /**
   * Maximum tokens per period (day/month)
   * @default unlimited
   */
  maxTokensPerPeriod?: number;

  /**
   * Maximum cost per period (USD)
   * @default unlimited
   */
  maxCostPerPeriod?: number;

  /**
   * Budget period
   * @default 'day'
   */
  period?: 'hour' | 'day' | 'week' | 'month';

  /**
   * How to track budget
   * @default 'global'
   */
  keyBy?: BudgetKey | ((context: { agentId: string; metadata?: any }) => string);

  /**
   * Action when budget is exceeded
   * @default 'reject'
   */
  onExceed?: 'reject' | 'fallback' | 'warn';

  /**
   * Fallback model to use when budget exceeded (if onExceed is 'fallback')
   */
  fallbackModel?: string;

  /**
   * Message when budget exceeded
   */
  exceededMessage?: string;

  /**
   * Custom model costs (per 1K tokens)
   */
  modelCosts?: ModelCosts;

  /**
   * Warning threshold (percentage of budget)
   * @default 0.8 (80%)
   */
  warningThreshold?: number;

  /**
   * Callback when warning threshold reached
   */
  onWarning?: (status: BudgetStatus) => void;

  /**
   * Callback when budget exceeded
   */
  onExceeded?: (status: BudgetStatus, context: {
    agentId: string;
    threadId?: string;
  }) => void;

  /**
   * Skip budget check for certain keys
   */
  skip?: (key: string, context: { agentId: string; metadata?: any }) => boolean;

  /**
   * Custom storage for persistence
   */
  storage?: {
    get: (key: string) => Promise<BudgetEntry | null>;
    set: (key: string, entry: BudgetEntry) => Promise<void>;
  };
}

/**
 * Token Budget Middleware
 * 
 * Controls token usage and costs with configurable limits.
 * Supports per-user, per-organization, or global budgets.
 * 
 * @example
 * ```typescript
 * import { TokenBudget } from '@snap-agent/middleware-budget';
 * 
 * const budget = new TokenBudget({
 *   maxTokensPerRequest: 4000,
 *   maxTokensPerPeriod: 100000,
 *   maxCostPerPeriod: 10.00, // $10/day
 *   period: 'day',
 *   keyBy: 'userId',
 *   onExceed: 'fallback',
 *   fallbackModel: 'gpt-4o-mini',
 * });
 * ```
 */
export class TokenBudget implements MiddlewarePlugin {
  name = 'token-budget';
  type = 'middleware' as const;
  priority = 15; // Run early, after rate limiter

  private config: Required<Omit<TokenBudgetConfig, 'storage' | 'skip' | 'onWarning' | 'onExceeded' | 'fallbackModel'>> &
    Pick<TokenBudgetConfig, 'storage' | 'skip' | 'onWarning' | 'onExceeded' | 'fallbackModel'>;
  
  private budgets: Map<string, BudgetEntry> = new Map();
  private modelCosts: ModelCosts;
  private warningsSent: Set<string> = new Set();

  constructor(config: TokenBudgetConfig = {}) {
    this.config = {
      maxTokensPerRequest: config.maxTokensPerRequest ?? Infinity,
      maxTokensPerPeriod: config.maxTokensPerPeriod ?? Infinity,
      maxCostPerPeriod: config.maxCostPerPeriod ?? Infinity,
      period: config.period ?? 'day',
      keyBy: config.keyBy ?? 'global',
      onExceed: config.onExceed ?? 'reject',
      exceededMessage: config.exceededMessage ?? 'Token budget exceeded. Please try again later.',
      warningThreshold: config.warningThreshold ?? 0.8,
      modelCosts: config.modelCosts ?? {},
      storage: config.storage,
      skip: config.skip,
      onWarning: config.onWarning,
      onExceeded: config.onExceeded,
      fallbackModel: config.fallbackModel,
    };

    this.modelCosts = { ...DEFAULT_MODEL_COSTS, ...this.config.modelCosts };

    // Cleanup expired entries periodically
    setInterval(() => this.cleanup(), 60 * 60 * 1000); // Every hour
  }

  async beforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ messages: any[]; metadata?: any }> {
    const key = this.getKey(context);

    // Check if should skip
    if (this.config.skip?.(key, context)) {
      return { messages, metadata: { budget: { skipped: true } } };
    }

    const status = await this.getStatus(key);

    // Check if already exceeded
    if (status.isExceeded) {
      this.config.onExceeded?.(status, context);

      if (this.config.onExceed === 'reject') {
        return {
          messages: [{ role: 'system', content: `[BUDGET_EXCEEDED] ${this.config.exceededMessage}` }],
          metadata: { budget: status, _skipLLM: true },
        };
      }

      if (this.config.onExceed === 'fallback' && this.config.fallbackModel) {
        // Signal to use fallback model
        return {
          messages,
          metadata: { 
            budget: status, 
            _useFallbackModel: this.config.fallbackModel,
          },
        };
      }
    }

    // Check warning threshold
    if (status.percentUsed >= this.config.warningThreshold * 100 && !this.warningsSent.has(key)) {
      this.warningsSent.add(key);
      this.config.onWarning?.(status);
    }

    return { messages, metadata: { budget: status, budgetKey: key } };
  }

  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    // If request was rejected due to budget
    if (context.metadata?._skipLLM) {
      return {
        response: this.config.exceededMessage,
        metadata: context.metadata,
      };
    }

    // Update budget usage based on response
    const key = context.metadata?.budgetKey || this.getKey(context);
    const tokensUsed = context.metadata?.tokensUsed || this.estimateTokens(response);
    const model = context.metadata?._useFallbackModel || context.metadata?.model || 'gpt-4o-mini';

    await this.trackUsage(key, tokensUsed, model);

    const status = await this.getStatus(key);

    return {
      response,
      metadata: {
        ...context.metadata,
        budget: status,
      },
    };
  }

  /**
   * Get the budget key for a context
   */
  private getKey(context: { agentId: string; metadata?: any }): string {
    if (typeof this.config.keyBy === 'function') {
      return this.config.keyBy(context);
    }

    switch (this.config.keyBy) {
      case 'userId':
        return `user:${context.metadata?.userId || 'anonymous'}`;
      case 'organizationId':
        return `org:${context.metadata?.organizationId || 'unknown'}`;
      case 'agentId':
        return `agent:${context.agentId}`;
      case 'global':
      default:
        return 'global';
    }
  }

  /**
   * Track token usage
   */
  async trackUsage(key: string, tokens: number, model: string): Promise<void> {
    const entry = await this.getEntry(key);
    const cost = this.calculateCost(tokens, model);

    entry.tokensUsed += tokens;
    entry.costUsed += cost;
    entry.requests++;

    await this.setEntry(key, entry);
  }

  /**
   * Get current budget status
   */
  async getStatus(key: string): Promise<BudgetStatus> {
    const entry = await this.getEntry(key);
    
    const tokensRemaining = Math.max(0, this.config.maxTokensPerPeriod - entry.tokensUsed);
    const costRemaining = Math.max(0, this.config.maxCostPerPeriod - entry.costUsed);
    
    const tokenPercent = this.config.maxTokensPerPeriod !== Infinity
      ? (entry.tokensUsed / this.config.maxTokensPerPeriod) * 100
      : 0;
    const costPercent = this.config.maxCostPerPeriod !== Infinity
      ? (entry.costUsed / this.config.maxCostPerPeriod) * 100
      : 0;
    const percentUsed = Math.max(tokenPercent, costPercent);

    const isExceeded = 
      entry.tokensUsed >= this.config.maxTokensPerPeriod ||
      entry.costUsed >= this.config.maxCostPerPeriod;

    return {
      key,
      tokensUsed: entry.tokensUsed,
      tokensLimit: this.config.maxTokensPerPeriod,
      tokensRemaining,
      costUsed: entry.costUsed,
      costLimit: this.config.maxCostPerPeriod,
      costRemaining,
      percentUsed,
      resetAt: new Date(entry.resetAt),
      isExceeded,
    };
  }

  /**
   * Get entry from storage
   */
  private async getEntry(key: string): Promise<BudgetEntry> {
    const now = Date.now();

    if (this.config.storage) {
      const stored = await this.config.storage.get(key);
      if (stored && now < stored.resetAt) {
        return stored;
      }
    } else {
      const cached = this.budgets.get(key);
      if (cached && now < cached.resetAt) {
        return cached;
      }
    }

    // Create new entry
    return {
      tokensUsed: 0,
      costUsed: 0,
      resetAt: this.getNextReset(),
      requests: 0,
    };
  }

  /**
   * Set entry in storage
   */
  private async setEntry(key: string, entry: BudgetEntry): Promise<void> {
    if (this.config.storage) {
      await this.config.storage.set(key, entry);
    } else {
      this.budgets.set(key, entry);
    }
  }

  /**
   * Get next reset timestamp
   */
  private getNextReset(): number {
    const now = new Date();
    
    switch (this.config.period) {
      case 'hour':
        now.setHours(now.getHours() + 1, 0, 0, 0);
        break;
      case 'day':
        now.setDate(now.getDate() + 1);
        now.setHours(0, 0, 0, 0);
        break;
      case 'week':
        now.setDate(now.getDate() + (7 - now.getDay()));
        now.setHours(0, 0, 0, 0);
        break;
      case 'month':
        now.setMonth(now.getMonth() + 1, 1);
        now.setHours(0, 0, 0, 0);
        break;
    }

    return now.getTime();
  }

  /**
   * Calculate cost for tokens
   */
  private calculateCost(tokens: number, model: string): number {
    const costs = this.modelCosts[model];
    if (!costs) {
      // Default to a mid-range cost
      return (tokens / 1000) * 0.002;
    }
    // Assume 50/50 split between input and output for estimation
    const avgCost = (costs.input + costs.output) / 2;
    return (tokens / 1000) * avgCost;
  }

  /**
   * Estimate tokens in text (rough estimation)
   */
  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.budgets.entries()) {
      if (now > entry.resetAt) {
        this.budgets.delete(key);
        this.warningsSent.delete(key);
      }
    }
  }

  /**
   * Reset budget for a key
   */
  reset(key: string): void {
    this.budgets.delete(key);
    this.warningsSent.delete(key);
  }

  /**
   * Add tokens to a key's budget (for top-ups)
   */
  async addBudget(key: string, tokens: number): Promise<void> {
    const entry = await this.getEntry(key);
    entry.tokensUsed = Math.max(0, entry.tokensUsed - tokens);
    await this.setEntry(key, entry);
  }
}

