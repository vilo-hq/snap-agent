import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/core/Agent';
import type { AgentData } from '../../src/types';

const { mockStreamText } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: mockStreamText,
  Output: {},
  stepCountIs: vi.fn(),
}));

describe('Agent.streamResponse', () => {
  let agent: Agent;
  let providerFactory: { getModel: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    providerFactory = {
      getModel: vi.fn().mockResolvedValue({ provider: 'mock-model' }),
    };

    agent = new Agent(
      {
        id: 'agent-1',
        name: 'Test Agent',
        instructions: 'Be helpful.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        files: [],
        plugins: [],
      } as AgentData,
      {} as any,
      providerFactory as any
    );

    mockStreamText.mockReturnValue({
      textStream: (async function* () {
        yield 'Hello';
      })(),
    });
  });

  it('should route async onComplete rejections to onError', async () => {
    const completionError = new Error('async completion failed');
    const onError = vi.fn();

    await agent.streamResponse(
      [{ role: 'user', content: 'Hi' }],
      vi.fn(),
      async () => {
        throw completionError;
      },
      onError
    );

    expect(onError).toHaveBeenCalledWith(completionError);
  });
});