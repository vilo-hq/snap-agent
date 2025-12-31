import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBudget, TokenBudgetConfig } from '../src/TokenBudget';

describe('TokenBudget', () => {
  let budget: TokenBudget;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create budget with default config', () => {
      budget = new TokenBudget();
      expect(budget).toBeInstanceOf(TokenBudget);
      expect(budget.name).toBe('token-budget');
      expect(budget.type).toBe('middleware');
      expect(budget.priority).toBe(15);
    });

    it('should accept custom config', () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 50000,
        maxCostPerPeriod: 10.00,
        period: 'day',
        keyBy: 'userId',
      });
      expect(budget).toBeInstanceOf(TokenBudget);
    });

    it('should accept custom model costs', () => {
      budget = new TokenBudget({
        modelCosts: {
          'custom-model': { input: 0.01, output: 0.02 },
        },
      });
      expect(budget).toBeInstanceOf(TokenBudget);
    });
  });

  // ==========================================================================
  // beforeRequest Tests
  // ==========================================================================

  describe('beforeRequest', () => {
    it('should allow request when under budget', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 10000,
        maxCostPerPeriod: 5.00,
      });

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.messages).toHaveLength(1);
      expect(result.metadata?.budget).toBeDefined();
      expect(result.metadata?.budget.isExceeded).toBe(false);
    });

    it('should reject request when budget exceeded', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 100,
        onExceed: 'reject',
      });

      // Exhaust budget
      await budget.trackUsage('global', 150, 'gpt-4o');

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?._skipLLM).toBe(true);
      expect(result.messages[0].content).toContain('BUDGET_EXCEEDED');
    });

    it('should use fallback model when budget exceeded and onExceed is fallback', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 100,
        onExceed: 'fallback',
        fallbackModel: 'gpt-4o-mini',
      });

      await budget.trackUsage('global', 150, 'gpt-4o');

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?._useFallbackModel).toBe('gpt-4o-mini');
    });

    it('should skip budget check when skip returns true', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 100,
        skip: (key, context) => context.metadata?.role === 'admin',
      });

      await budget.trackUsage('global', 150, 'gpt-4o');

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1', metadata: { role: 'admin' } }
      );

      expect(result.metadata?.budget.skipped).toBe(true);
    });

    it('should trigger warning callback at threshold', async () => {
      const onWarning = vi.fn();
      budget = new TokenBudget({
        maxTokensPerPeriod: 1000,
        warningThreshold: 0.8,
        onWarning,
      });

      await budget.trackUsage('global', 850, 'gpt-4o');

      await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(onWarning).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // afterResponse Tests
  // ==========================================================================

  describe('afterResponse', () => {
    it('should track usage after response', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 10000,
      });

      const beforeStatus = await budget.getStatus('global');
      expect(beforeStatus.tokensUsed).toBe(0);

      await budget.afterResponse(
        'This is a response',
        { 
          agentId: 'agent-1', 
          metadata: { budgetKey: 'global', tokensUsed: 100, model: 'gpt-4o' } 
        }
      );

      const afterStatus = await budget.getStatus('global');
      expect(afterStatus.tokensUsed).toBe(100);
    });

    it('should return exceeded message when skipped', async () => {
      budget = new TokenBudget({
        exceededMessage: 'Budget exceeded!',
      });

      const result = await budget.afterResponse(
        'Original response',
        { agentId: 'agent-1', metadata: { _skipLLM: true } }
      );

      expect(result.response).toBe('Budget exceeded!');
    });
  });

  // ==========================================================================
  // keyBy Tests
  // ==========================================================================

  describe('keyBy options', () => {
    it('should use userId for budget key', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 1000,
        keyBy: 'userId',
      });

      await budget.trackUsage('user:user-1', 100, 'gpt-4o');
      await budget.trackUsage('user:user-2', 200, 'gpt-4o');

      const status1 = await budget.getStatus('user:user-1');
      const status2 = await budget.getStatus('user:user-2');

      expect(status1.tokensUsed).toBe(100);
      expect(status2.tokensUsed).toBe(200);
    });

    it('should use organizationId for budget key', async () => {
      budget = new TokenBudget({
        keyBy: 'organizationId',
      });

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1', metadata: { organizationId: 'org-123' } }
      );

      expect(result.metadata?.budgetKey).toBe('org:org-123');
    });

    it('should use custom key function', async () => {
      budget = new TokenBudget({
        keyBy: (context) => `custom:${context.metadata?.customId || 'default'}`,
      });

      const result = await budget.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1', metadata: { customId: 'abc' } }
      );

      expect(result.metadata?.budgetKey).toBe('custom:abc');
    });
  });

  // ==========================================================================
  // getStatus Tests
  // ==========================================================================

  describe('getStatus', () => {
    it('should return correct status', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 1000,
        maxCostPerPeriod: 1.00,
      });

      await budget.trackUsage('global', 300, 'gpt-4o');

      const status = await budget.getStatus('global');

      expect(status.key).toBe('global');
      expect(status.tokensUsed).toBe(300);
      expect(status.tokensLimit).toBe(1000);
      expect(status.tokensRemaining).toBe(700);
      expect(status.isExceeded).toBe(false);
    });

    it('should calculate percent used correctly', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 1000,
      });

      await budget.trackUsage('global', 500, 'gpt-4o');

      const status = await budget.getStatus('global');
      expect(status.percentUsed).toBeCloseTo(50, 0);
    });

    it('should mark as exceeded when over limit', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 100,
      });

      await budget.trackUsage('global', 150, 'gpt-4o');

      const status = await budget.getStatus('global');
      expect(status.isExceeded).toBe(true);
    });
  });

  // ==========================================================================
  // trackUsage Tests
  // ==========================================================================

  describe('trackUsage', () => {
    it('should accumulate token usage', async () => {
      budget = new TokenBudget();

      await budget.trackUsage('global', 100, 'gpt-4o');
      await budget.trackUsage('global', 200, 'gpt-4o');

      const status = await budget.getStatus('global');
      expect(status.tokensUsed).toBe(300);
    });

    it('should calculate cost based on model', async () => {
      budget = new TokenBudget();

      // gpt-4o: $0.005/1K input, $0.015/1K output, avg $0.01/1K
      await budget.trackUsage('global', 1000, 'gpt-4o');

      const status = await budget.getStatus('global');
      expect(status.costUsed).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // reset Tests
  // ==========================================================================

  describe('reset', () => {
    it('should reset budget for a key', async () => {
      budget = new TokenBudget();

      await budget.trackUsage('global', 500, 'gpt-4o');
      expect((await budget.getStatus('global')).tokensUsed).toBe(500);

      budget.reset('global');

      expect((await budget.getStatus('global')).tokensUsed).toBe(0);
    });
  });

  // ==========================================================================
  // addBudget Tests
  // ==========================================================================

  describe('addBudget', () => {
    it('should add tokens to budget (reduce usage)', async () => {
      budget = new TokenBudget();

      await budget.trackUsage('global', 500, 'gpt-4o');
      await budget.addBudget('global', 200);

      const status = await budget.getStatus('global');
      expect(status.tokensUsed).toBe(300);
    });

    it('should not go below zero', async () => {
      budget = new TokenBudget();

      await budget.trackUsage('global', 100, 'gpt-4o');
      await budget.addBudget('global', 500);

      const status = await budget.getStatus('global');
      expect(status.tokensUsed).toBe(0);
    });
  });

  // ==========================================================================
  // Custom Storage Tests
  // ==========================================================================

  describe('custom storage', () => {
    it('should use custom storage adapter', async () => {
      const storage = {
        data: new Map<string, any>(),
        get: vi.fn(async (key: string) => storage.data.get(key) || null),
        set: vi.fn(async (key: string, entry: any) => {
          storage.data.set(key, entry);
        }),
      };

      budget = new TokenBudget({
        storage,
      });

      await budget.trackUsage('global', 100, 'gpt-4o');

      expect(storage.set).toHaveBeenCalled();

      const status = await budget.getStatus('global');
      expect(storage.get).toHaveBeenCalled();
      expect(status.tokensUsed).toBe(100);
    });
  });

  // ==========================================================================
  // Period Tests
  // ==========================================================================

  describe('budget periods', () => {
    it('should reset at correct time for day period', async () => {
      budget = new TokenBudget({
        maxTokensPerPeriod: 1000,
        period: 'day',
      });

      await budget.trackUsage('global', 500, 'gpt-4o');

      const status = await budget.getStatus('global');
      expect(status.resetAt).toBeInstanceOf(Date);
      expect(status.resetAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});

