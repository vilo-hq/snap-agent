import type { ProviderType } from '../types';

/**
 * How much a model should think before answering, as one provider-neutral setting.
 *
 * WHY: the model id alone leaves reasoning at each provider's default, and for reasoning models
 * that default is "think on every turn". For chat, where answers are short, the wait is dominated
 * by time to first token — and thinking happens before the first token. A fast model with
 * reasoning on can answer slower than a slow model with it off.
 *
 * - `off`    — as little thinking as the model allows. Some models cannot turn it off entirely
 *              (o-series, Claude Fable, Gemini 2.5 Pro); they get their lowest setting.
 * - `low` / `medium` / `high` — increasing depth.
 * - unset    — send nothing: the provider's default. Existing agents keep behaving as before.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** The `providerOptions` value for `generateText` / `streamText` (AI SDK v5+). */
export type ReasoningProviderOptions = Record<string, Record<string, any>>;

/**
 * Translate a {@link ReasoningEffort} into the AI SDK `providerOptions` for one provider + model.
 * Returns `undefined` when there is nothing to send — unset effort, a model family without a
 * reasoning control, or a provider that has none — so callers can spread it unconditionally.
 *
 * Option names come from the installed provider packages' own types:
 *   @ai-sdk/openai    `reasoningEffort`: none | minimal | low | medium | high | xhigh
 *   @ai-sdk/anthropic `thinking`: adaptive | enabled{budgetTokens} | disabled, `effort`: low..max
 *   @ai-sdk/google    `thinkingConfig`: { thinkingLevel: minimal..high } | { thinkingBudget: n }
 */
export function reasoningProviderOptions(
  provider: ProviderType,
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningProviderOptions | undefined {
  if (!effort) return undefined;
  const id = model.toLowerCase();

  switch (provider) {
    case 'openai': {
      const reasoningEffort = openaiEffort(id, effort);
      return reasoningEffort ? { openai: { reasoningEffort } } : undefined;
    }
    case 'anthropic': {
      const options = anthropicOptions(id, effort);
      return options ? { anthropic: options } : undefined;
    }
    case 'google': {
      const thinkingConfig = googleThinkingConfig(id, effort);
      return thinkingConfig ? { google: { thinkingConfig } } : undefined;
    }
    default:
      return undefined;
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

function openaiEffort(id: string, effort: ReasoningEffort): string | undefined {
  const isOSeries = /^o\d/.test(id);
  const isGpt5Original = /^gpt-5(-mini|-nano|-pro)?$/.test(id); // gpt-5 predates `none`
  const isReasoningGpt = /^gpt-(5|6)/.test(id);
  // gpt-4o / gpt-4.1 are not reasoning models: sending the option only earns a warning.
  if (!isOSeries && !isReasoningGpt) return undefined;
  if (effort !== 'off') return effort;
  if (isOSeries) return 'low'; // o-series cannot go below low
  if (isGpt5Original) return 'minimal';
  return 'none'; // gpt-5.1+ and gpt-6
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

const ANTHROPIC_BUDGETS = { low: 1024, medium: 4096, high: 16000 } as const;

function anthropicOptions(id: string, effort: ReasoningEffort): Record<string, any> | undefined {
  if (!id.startsWith('claude-')) return undefined;

  // Fable: thinking is always on and an explicit `disabled` is rejected — `off` means lowest effort.
  if (id.startsWith('claude-fable') || id.startsWith('claude-mythos')) {
    return { effort: effort === 'off' ? 'low' : effort };
  }

  // Adaptive-thinking generation: Opus 4.6+ (including 5 and 5.5), Sonnet 4.6+, Sonnet 5.
  if (/^claude-(opus-(4-[6-9]|5)|sonnet-(4-[6-9]|5))/.test(id)) {
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'adaptive' }, effort };
  }

  // Earlier models (Haiku 4.5, Sonnet/Opus 4.5): fixed thinking budgets, no effort control.
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  return { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGETS[effort] } };
}

// ── Google ────────────────────────────────────────────────────────────────────

const GEMINI_25_BUDGETS = { low: 1024, medium: 4096, high: 16384 } as const;

function googleThinkingConfig(id: string, effort: ReasoningEffort): Record<string, any> | undefined {
  if (!id.startsWith('gemini-')) return undefined;

  // Gemini 2.5 takes a token budget; 0 turns thinking off, except on Pro, whose floor is 128.
  if (id.startsWith('gemini-2.5')) {
    if (effort === 'off') return { thinkingBudget: id.includes('pro') ? 128 : 0 };
    return { thinkingBudget: GEMINI_25_BUDGETS[effort] };
  }

  // Gemini 3.x takes a level; `minimal` is its lowest.
  if (/^gemini-3/.test(id)) {
    return { thinkingLevel: effort === 'off' ? 'minimal' : effort };
  }

  return undefined; // older families have no thinking control
}
