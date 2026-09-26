import { describe, expect, it } from 'vitest';
import { isReasoningEffort, reasoningProviderOptions } from '../../src/providers/reasoning';

const r = reasoningProviderOptions;

describe('reasoningProviderOptions', () => {
  it('sends nothing when unset, so existing agents keep the provider default', () => {
    expect(r('openai', 'gpt-6-luna', undefined)).toBeUndefined();
    expect(r('anthropic', 'claude-opus-5', undefined)).toBeUndefined();
    expect(r('google', 'gemini-3.1-flash-lite', undefined)).toBeUndefined();
  });

  describe('openai', () => {
    it('turns reasoning fully off on gpt-5.1+ and gpt-6', () => {
      expect(r('openai', 'gpt-6-luna', 'off')).toEqual({ openai: { reasoningEffort: 'none' } });
      expect(r('openai', 'gpt-5.4-nano', 'off')).toEqual({ openai: { reasoningEffort: 'none' } });
    });
    it('uses minimal on the original gpt-5 family and low on the o-series', () => {
      expect(r('openai', 'gpt-5-mini', 'off')).toEqual({ openai: { reasoningEffort: 'minimal' } });
      expect(r('openai', 'o4-mini', 'off')).toEqual({ openai: { reasoningEffort: 'low' } });
    });
    it('passes levels through and skips non-reasoning models', () => {
      expect(r('openai', 'gpt-6-sol', 'high')).toEqual({ openai: { reasoningEffort: 'high' } });
      expect(r('openai', 'gpt-4o', 'off')).toBeUndefined();
      expect(r('openai', 'gpt-4.1-mini', 'low')).toBeUndefined();
    });
  });

  describe('anthropic', () => {
    it('disables thinking on the adaptive generation and maps levels to effort', () => {
      for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
        expect(r('anthropic', model, 'off')).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
        expect(r('anthropic', model, 'medium')).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } });
      }
    });
    it('never sends disabled to Fable, which rejects it', () => {
      expect(r('anthropic', 'claude-fable-5-1', 'off')).toEqual({ anthropic: { effort: 'low' } });
      expect(r('anthropic', 'claude-fable-5', 'high')).toEqual({ anthropic: { effort: 'high' } });
    });
    it('uses thinking budgets on earlier models without effort', () => {
      expect(r('anthropic', 'claude-haiku-4-5', 'off')).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
      expect(r('anthropic', 'claude-haiku-4-5', 'low')).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } } });
    });
  });

  describe('google', () => {
    it('uses thinking levels on Gemini 3.x', () => {
      expect(r('google', 'gemini-3.1-flash-lite', 'off')).toEqual({ google: { thinkingConfig: { thinkingLevel: 'minimal' } } });
      expect(r('google', 'gemini-3.8-flash', 'high')).toEqual({ google: { thinkingConfig: { thinkingLevel: 'high' } } });
    });
    it('uses budgets on Gemini 2.5, respecting the Pro floor', () => {
      expect(r('google', 'gemini-2.5-flash-lite', 'off')).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } });
      expect(r('google', 'gemini-2.5-pro', 'off')).toEqual({ google: { thinkingConfig: { thinkingBudget: 128 } } });
    });
  });

  it('ignores providers without a reasoning control', () => {
    expect(r('huggingface', 'meta-llama/Llama-3.3-70B-Instruct', 'off')).toBeUndefined();
  });

  it('validates stored values', () => {
    expect(isReasoningEffort('off')).toBe(true);
    expect(isReasoningEffort('xhigh')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });
});
