import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/core/Agent';
import { ModelCircuitBreaker, modelCircuitBreaker } from '../../src/core/modelRouting';
import type { AgentData } from '../../src/types';

/**
 * Failover behaviour, with `ai` mocked: each fake model is `{ key: 'provider:model' }`, and the mocked
 * streamText / generateText look up a scripted behaviour by that key.
 */
const { mockStreamText, mockGenerateText } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', () => ({
  generateText: mockGenerateText,
  streamText: mockStreamText,
  Output: { object: vi.fn() },
  stepCountIs: vi.fn(() => 'stop'),
}));

type Script =
  | { kind: 'text'; text: string; delayMs?: number }
  | { kind: 'error'; error: Error & { statusCode?: number } }
  | { kind: 'hang' } // never produces anything (until aborted)
  | { kind: 'tool-then-error'; error: Error };

let scripts: Record<string, Script>;
let calls: string[];

function fakeStream(script: Script, signal?: AbortSignal) {
  async function* parts() {
    yield { type: 'start' };
    yield { type: 'start-step' };
    if (script.kind === 'error') { yield { type: 'error', error: script.error }; return; }
    if (script.kind === 'hang') {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      return;
    }
    if (script.kind === 'tool-then-error') {
      yield { type: 'tool-input-start', id: 'c1', toolName: 'send_email' };
      yield { type: 'tool-call', toolCallId: 'c1', toolName: 'send_email', input: {} };
      yield { type: 'error', error: script.error };
      return;
    }
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    yield { type: 'text-delta', id: 't', text: script.text };
    yield { type: 'finish' };
  }
  return { fullStream: parts(), usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }) };
}

function makeAgent(overrides: Partial<AgentData> = {}) {
  const providerFactory = {
    getModel: vi.fn(async (provider: string, model: string) => ({ key: `${provider}:${model}` })),
  };
  const agent = new Agent(
    {
      id: 'agent-1', name: 'A', instructions: 'Be helpful.', userId: 'u', createdAt: new Date(), updatedAt: new Date(),
      files: [], plugins: [],
      provider: 'cerebras', model: 'gpt-oss-120b', reasoning: 'off',
      fallback: { provider: 'openai', model: 'gpt-4o' },
      ...overrides,
    } as AgentData,
    {} as any,
    providerFactory as any,
  );
  return { agent, providerFactory };
}

async function stream(agent: Agent, options: Record<string, unknown> = {}) {
  const chunks: string[] = [];
  let meta: Record<string, any> | undefined;
  let error: Error | undefined;
  await agent.streamResponse(
    [{ role: 'user', content: 'hi' }],
    (c) => chunks.push(c),
    (_t, m) => { meta = m; },
    (e) => { error = e; },
    options as any,
  );
  return { text: chunks.join(''), meta, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  modelCircuitBreaker.reset();
  modelCircuitBreaker.configure({ failureThreshold: 3, cooldownMs: 30_000 });
  calls = [];
  scripts = {};
  mockStreamText.mockImplementation((args: any) => {
    calls.push(args.model.key);
    return fakeStream(scripts[args.model.key], args.abortSignal);
  });
  mockGenerateText.mockImplementation(async (args: any) => {
    calls.push(args.model.key);
    const s = scripts[args.model.key];
    if (s.kind === 'error') throw s.error;
    if (s.kind === 'tool-then-error') { await args.tools.send_email.execute({}); throw s.error; }
    return { text: s.kind === 'text' ? s.text : '', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] };
  });
});

const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { statusCode: status });

describe('streamResponse failover', () => {
  it('answers with the primary when it is healthy', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'text', text: 'fast' }, 'openai:gpt-4o': { kind: 'text', text: 'slow' } };
    const { agent } = makeAgent();
    const r = await stream(agent);
    expect(r.text).toBe('fast');
    expect(r.meta?.servedBy).toEqual({ provider: 'cerebras', model: 'gpt-oss-120b' });
    expect(calls).toEqual(['cerebras:gpt-oss-120b']);
  });

  it('falls back when the primary errors before answering, without retrying the primary', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(503) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    const r = await stream(agent);
    expect(r.text).toBe('backup');
    expect(r.meta?.servedBy).toMatchObject({ provider: 'openai', model: 'gpt-4o', fallback: { reason: 'error', from: { provider: 'cerebras' } } });
    expect(calls).toEqual(['cerebras:gpt-oss-120b', 'openai:gpt-4o']);
  });

  it('falls back when the primary shows no sign of life before the deadline', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'hang' }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    const started = Date.now();
    const r = await stream(agent, { firstTokenTimeoutMs: 50 });
    expect(r.text).toBe('backup');
    expect(r.meta?.servedBy.fallback.reason).toBe('first_token_timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never replays a turn whose primary already started a tool call', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'tool-then-error', error: httpError(500) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    const r = await stream(agent);
    expect(r.error?.message).toBe('HTTP 500');
    expect(calls).toEqual(['cerebras:gpt-oss-120b']); // fallback NOT called
  });

  it('opens the circuit after repeated failures and then skips the primary', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(503) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    for (let i = 0; i < 3; i++) await stream(agent);
    calls = [];
    const r = await stream(agent);
    expect(r.meta?.servedBy.fallback.reason).toBe('circuit_open');
    expect(calls).toEqual(['openai:gpt-4o']);
  });

  it('keeps today\'s behaviour without a fallback: retries the only model and reports the error', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(400, 'bad request') } };
    const { agent } = makeAgent({ fallback: undefined });
    const r = await stream(agent);
    expect(r.error?.message).toBe('bad request');
    expect(calls).toEqual(['cerebras:gpt-oss-120b']); // 400 is not retryable
  });

  it('rebuilds the system prompt for the model that actually serves the turn', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(503) }, 'openai:gpt-4o': { kind: 'text', text: 'ok' } };
    const { agent } = makeAgent();
    const seen: string[] = [];
    await stream(agent, { buildSystemPrompt: (ctx: any) => { seen.push(`${ctx.provider}:${ctx.model}`); return 'sys'; } });
    expect(seen).toEqual(['cerebras:gpt-oss-120b', 'openai:gpt-4o']);
  });

  it('can disable failover for a single call', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(400) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    const r = await stream(agent, { fallback: null });
    expect(r.error).toBeDefined();
    expect(calls).toEqual(['cerebras:gpt-oss-120b']);
  });
});

describe('generateResponse failover', () => {
  it('falls back on a primary error', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'error', error: httpError(502) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const { agent } = makeAgent();
    const r = await agent.generateResponse([{ role: 'user', content: 'hi' }]);
    expect(r.text).toBe('backup');
    expect(r.metadata?.servedBy.fallback.reason).toBe('error');
  });

  it('does not replay after a tool already ran on the primary', async () => {
    scripts = { 'cerebras:gpt-oss-120b': { kind: 'tool-then-error', error: httpError(500) }, 'openai:gpt-4o': { kind: 'text', text: 'backup' } };
    const email = vi.fn(async () => 'sent');
    const { agent } = makeAgent();
    (agent as any).pluginManager.getAISDKTools = () => ({ send_email: { description: 'x', execute: email } });
    await expect(agent.generateResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 500');
    expect(email).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['cerebras:gpt-oss-120b']);
  });
});

describe('ModelCircuitBreaker', () => {
  it('opens at the threshold, lets one probe through after the cooldown, and closes on success', () => {
    let now = 0;
    const b = new ModelCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 }, () => now);
    const t = { provider: 'cerebras', model: 'gpt-oss-120b' };
    b.recordFailure(t);
    expect(b.allow(t)).toBe(true);
    b.recordFailure(t);
    expect(b.state(t)).toBe('open');
    expect(b.allow(t)).toBe(false);
    now = 1500;
    expect(b.allow(t)).toBe(true);  // the probe
    expect(b.allow(t)).toBe(false); // only one at a time
    b.recordSuccess(t);
    expect(b.state(t)).toBe('closed');
  });

  it('re-opens immediately when the probe fails', () => {
    let now = 0;
    const b = new ModelCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 }, () => now);
    const t = { provider: 'cerebras', model: 'gpt-oss-120b' };
    b.recordFailure(t); b.recordFailure(t);
    now = 1500;
    expect(b.allow(t)).toBe(true);
    b.recordFailure(t);
    expect(b.state(t)).toBe('open');
  });
});
