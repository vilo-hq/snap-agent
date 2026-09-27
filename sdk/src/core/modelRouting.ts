import type { ProviderType } from '../types';
import { isReasoningEffort, type ReasoningEffort } from '../providers/reasoning';

/**
 * Model failover: an agent answers with its primary model and, when that model is down or too slow
 * to START answering, with a fallback model from another provider (e.g. Cerebras gpt-oss-120b backed
 * by OpenAI gpt-4o). "Always on" without giving up the primary's speed.
 *
 * The one hard rule is side effects. Tools can send email, post webhooks or capture leads. A turn is
 * only re-run on the fallback while the primary has produced NOTHING — no text, no tool call. Once
 * it has, the turn is committed to it: a later failure is reported, never replayed, so no tool runs
 * twice. See `Agent.streamResponse` / `Agent.generateResponse`.
 */

/** A model an agent can answer with. */
export interface ModelTarget {
  provider: ProviderType;
  model: string;
  /** Reasoning level for this target. Unset = the agent's `reasoning` (or the provider default). */
  reasoning?: ReasoningEffort;
}

const PROVIDERS: readonly ProviderType[] = ['openai', 'anthropic', 'google', 'huggingface', 'groq', 'cerebras'];

/** Shape check for stored / API-supplied fallbacks. */
export function isModelTarget(value: unknown): value is ModelTarget {
  const v = value as Partial<ModelTarget> | null;
  return !!v && typeof v === 'object'
    && typeof v.provider === 'string' && (PROVIDERS as readonly string[]).includes(v.provider)
    && typeof v.model === 'string' && v.model.trim().length > 0
    && (v.reasoning === undefined || isReasoningEffort(v.reasoning));
}

/** Why a turn left the primary model. */
export type FallbackReason =
  | 'error'            // the primary failed before producing anything
  | 'first_token_timeout' // no text and no tool call within the deadline
  | 'circuit_open';    // the primary failed repeatedly; skipped without trying

/** How a turn was actually served. Attached to response metadata and analytics. */
export interface ServedBy {
  provider: ProviderType;
  model: string;
  /** Present when the fallback answered. */
  fallback?: {
    from: { provider: ProviderType; model: string };
    reason: FallbackReason;
    /** The primary's error message, when there was one. */
    error?: string;
  };
}

/**
 * Deadline for the primary to show the first sign of life (text or a tool call) before the turn moves
 * to the fallback. Only applies when a fallback is configured. Measured on Cerebras gpt-oss-120b the
 * p90 time to first text is ~0.75 s including tool steps; 2.5 s leaves room for slow tool round-trips
 * and still bounds the wait on a degraded provider.
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 2500;

export const targetKey = (t: { provider: string; model: string }): string => `${t.provider}:${t.model}`;

// ── Circuit breaker ───────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long an open circuit skips the target before letting one probe through. */
  cooldownMs: number;
}

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  probing: boolean;
}

/**
 * Per-target circuit breaker, shared by every agent in the process. Without it, every request during
 * an outage would wait for the error or the first-token deadline before falling back.
 *
 * closed → (N consecutive failures) → open → (cooldown) → half-open: ONE request probes the target;
 * success closes the circuit, failure re-opens it for another cooldown. Only consulted when the agent
 * has a fallback — an agent without one always tries its only model.
 */
export class ModelCircuitBreaker {
  private states = new Map<string, CircuitState>();

  constructor(
    private options: CircuitBreakerOptions = { failureThreshold: 3, cooldownMs: 30_000 },
    private now: () => number = () => Date.now(),
  ) {}

  configure(options: Partial<CircuitBreakerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** True when a request should try this target. Claims the single half-open probe when due. */
  allow(target: { provider: string; model: string }): boolean {
    const s = this.states.get(targetKey(target));
    if (!s || s.openedAt === null) return true;
    if (this.now() - s.openedAt < this.options.cooldownMs) return false;
    if (s.probing) return false; // someone else is already probing
    s.probing = true;
    return true;
  }

  recordSuccess(target: { provider: string; model: string }): void {
    this.states.delete(targetKey(target));
  }

  recordFailure(target: { provider: string; model: string }): void {
    const key = targetKey(target);
    const s = this.states.get(key) ?? { consecutiveFailures: 0, openedAt: null, probing: false };
    s.consecutiveFailures += 1;
    if (s.probing || s.consecutiveFailures >= this.options.failureThreshold) {
      s.openedAt = this.now();
    }
    s.probing = false;
    this.states.set(key, s);
  }

  /** Current state, for logs and tests. */
  state(target: { provider: string; model: string }): 'closed' | 'open' | 'half-open' {
    const s = this.states.get(targetKey(target));
    if (!s || s.openedAt === null) return 'closed';
    return this.now() - s.openedAt < this.options.cooldownMs ? 'open' : 'half-open';
  }

  reset(): void {
    this.states.clear();
  }
}

/** The process-wide breaker used by `Agent`. Tune with `modelCircuitBreaker.configure(...)`. */
export const modelCircuitBreaker = new ModelCircuitBreaker();

/** Rejects after `ms`, for racing the first stream part. `cancel` stops the timer. */
export function deadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FirstTokenTimeoutError(ms)), ms);
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
}

export class FirstTokenTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`no first token within ${timeoutMs} ms`);
    this.name = 'FirstTokenTimeoutError';
  }
}
