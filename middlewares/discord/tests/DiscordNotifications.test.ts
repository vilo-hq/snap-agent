import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordNotifications, DiscordConfig } from '../src/DiscordNotifications';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('DiscordNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('constructor', () => {
    it('should create instance with required config', () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      });
      expect(discord).toBeInstanceOf(DiscordNotifications);
      expect(discord.name).toBe('discord-notifications');
      expect(discord.type).toBe('middleware');
    });

    it('should throw if webhookUrl is missing', () => {
      expect(() => new DiscordNotifications({} as DiscordConfig))
        .toThrow('webhookUrl is required');
    });

    it('should accept custom config', () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        username: 'MyBot',
        triggers: { onError: true, onKeywords: ['help'] },
      });
      expect(discord).toBeInstanceOf(DiscordNotifications);
    });
  });

  describe('beforeRequest', () => {
    it('should pass through messages', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      });

      const result = await discord.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.messages).toHaveLength(1);
      expect(result.metadata?.discordRequestId).toBeDefined();
    });

    it('should send notification on keyword match in input', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onKeywords: ['urgent'] },
      });

      await discord.beforeRequest(
        [{ role: 'user', content: 'This is urgent!' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('afterResponse', () => {
    it('should pass through response', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      });

      const result = await discord.afterResponse(
        'Hello! How can I help?',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(result.response).toBe('Hello! How can I help?');
    });

    it('should send notification on long response', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onLongResponse: 50 },
      });

      // Setup a pending message and capture the requestId
      const beforeResult = await discord.beforeRequest(
        [{ role: 'user', content: 'Test' }],
        { agentId: 'agent-1' }
      );
      const requestId = beforeResult.metadata?.discordRequestId;

      // Wait to exceed threshold
      await new Promise((resolve) => setTimeout(resolve, 100));

      await discord.afterResponse(
        'Response',
        { agentId: 'agent-1', metadata: { discordRequestId: requestId } }
      );

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should send notification on keyword match in output', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onKeywords: ['error'] },
      });

      await discord.afterResponse(
        'There was an error processing your request',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should send notification on every N requests', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onEveryN: 3 },
      });

      // First 2 requests - no notification
      await discord.afterResponse('R1', { agentId: 'a', metadata: {} });
      await discord.afterResponse('R2', { agentId: 'a', metadata: {} });
      expect(mockFetch).not.toHaveBeenCalled();

      // 3rd request - should notify
      await discord.afterResponse('R3', { agentId: 'a', metadata: {} });
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support custom trigger function', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: {
          custom: (ctx) => ctx.output?.includes('ALERT') || false,
        },
      });

      await discord.afterResponse('Normal response', { agentId: 'a', metadata: {} });
      expect(mockFetch).not.toHaveBeenCalled();

      await discord.afterResponse('ALERT: Something happened', { agentId: 'a', metadata: {} });
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('notifyError', () => {
    it('should send error notification when enabled', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onError: true },
      });

      await discord.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].title).toBe('Agent Error');
    });

    it('should not send error notification when disabled', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onError: false },
      });

      await discord.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include mention on error', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onError: true },
        mentionOnError: '<@&123456>',
      });

      await discord.notifyError(new Error('Test'), { agentId: 'agent-1' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.content).toContain('<@&123456>');
    });
  });

  describe('custom formatMessage', () => {
    it('should use custom formatter', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onError: true },
        formatMessage: (ctx) => ({
          content: `Custom: ${ctx.error?.message}`,
        }),
      });

      await discord.notifyError(new Error('Oops'), { agentId: 'agent-1' });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.content).toBe('Custom: Oops');
    });

    it('should skip notification if formatter returns null', async () => {
      const discord = new DiscordNotifications({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        triggers: { onError: true },
        formatMessage: () => null,
      });

      await discord.notifyError(new Error('Oops'), { agentId: 'agent-1' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

