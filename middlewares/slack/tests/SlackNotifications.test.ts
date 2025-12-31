import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackNotifications, SlackConfig } from '../src/SlackNotifications';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SlackNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('constructor', () => {
    it('should create instance with required config', () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
      });
      expect(slack).toBeInstanceOf(SlackNotifications);
      expect(slack.name).toBe('slack-notifications');
      expect(slack.type).toBe('middleware');
    });

    it('should throw if webhookUrl is missing', () => {
      expect(() => new SlackNotifications({} as SlackConfig))
        .toThrow('webhookUrl is required');
    });

    it('should accept custom config', () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        username: 'MyBot',
        iconEmoji: ':fire:',
        triggers: { onError: true, onKeywords: ['help'] },
      });
      expect(slack).toBeInstanceOf(SlackNotifications);
    });
  });

  describe('beforeRequest', () => {
    it('should pass through messages', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
      });

      const result = await slack.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.messages).toHaveLength(1);
      expect(result.metadata?.slackRequestId).toBeDefined();
    });

    it('should send notification on keyword match in input', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onKeywords: ['escalate'] },
      });

      await slack.beforeRequest(
        [{ role: 'user', content: 'Please escalate this' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/T00/B00/xxx',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('afterResponse', () => {
    it('should pass through response', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
      });

      const result = await slack.afterResponse(
        'Hello! How can I help?',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(result.response).toBe('Hello! How can I help?');
    });

    it('should send notification on long response', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onLongResponse: 50 },
      });

      // Setup a pending message and capture the requestId
      const beforeResult = await slack.beforeRequest(
        [{ role: 'user', content: 'Test' }],
        { agentId: 'agent-1' }
      );
      const requestId = beforeResult.metadata?.slackRequestId;

      // Wait to exceed threshold
      await new Promise((resolve) => setTimeout(resolve, 100));

      await slack.afterResponse(
        'Response',
        { agentId: 'agent-1', metadata: { slackRequestId: requestId } }
      );

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should send notification on keyword match in output', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onKeywords: ['failed'] },
      });

      await slack.afterResponse(
        'The operation failed',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should send notification on every N requests', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onEveryN: 2 },
      });

      await slack.afterResponse('R1', { agentId: 'a', metadata: {} });
      expect(mockFetch).not.toHaveBeenCalled();

      await slack.afterResponse('R2', { agentId: 'a', metadata: {} });
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support custom trigger function', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: {
          custom: (ctx) => (ctx.latency || 0) > 1000,
        },
      });

      await slack.afterResponse('Response', { agentId: 'a', metadata: {} });
      // Since we don't have pending message, latency is 0
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('notifyError', () => {
    it('should send error notification when enabled', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onError: true },
      });

      await slack.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.blocks[0].text.text).toBe('Agent Error');
    });

    it('should not send error notification when disabled', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onError: false },
      });

      await slack.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include mention on error', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onError: true },
        mentionOnError: '@oncall',
      });

      await slack.notifyError(new Error('Test'), { agentId: 'agent-1' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.text).toContain('@oncall');
    });
  });

  describe('custom formatMessage', () => {
    it('should use custom formatter', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onError: true },
        formatMessage: (ctx) => ({
          text: `Custom: ${ctx.error?.message}`,
        }),
      });

      await slack.notifyError(new Error('Oops'), { agentId: 'agent-1' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.text).toBe('Custom: Oops');
    });

    it('should skip notification if formatter returns null', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        triggers: { onError: true },
        formatMessage: () => null,
      });

      await slack.notifyError(new Error('Oops'), { agentId: 'agent-1' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('default message formatting', () => {
    it('should include username and icon_emoji', async () => {
      const slack = new SlackNotifications({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
        username: 'TestBot',
        iconEmoji: ':test:',
        triggers: { onError: true },
      });

      await slack.notifyError(new Error('Test'), { agentId: 'agent-1' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.username).toBe('TestBot');
      expect(body.icon_emoji).toBe(':test:');
    });
  });
});

