import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookNotifier, WebhookConfig } from '../src/WebhookNotifier';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('WebhookNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('constructor', () => {
    it('should create instance with required config', () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
      });
      expect(webhook).toBeInstanceOf(WebhookNotifier);
      expect(webhook.name).toBe('webhook-notifier');
      expect(webhook.type).toBe('middleware');
    });

    it('should throw if url is missing', () => {
      expect(() => new WebhookNotifier({} as WebhookConfig))
        .toThrow('url is required');
    });

    it('should accept custom config', () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response', 'error'],
        headers: { 'Authorization': 'Bearer token' },
        timeout: 10000,
        retries: 3,
      });
      expect(webhook).toBeInstanceOf(WebhookNotifier);
    });
  });

  describe('beforeRequest', () => {
    it('should pass through messages', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
      });

      const result = await webhook.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(result.messages).toHaveLength(1);
      expect(result.metadata?.webhookRequestId).toBeDefined();
    });

    it('should send webhook for request event', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['request'],
        async: false,
      });

      await webhook.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe('request');
    });

    it('should not send webhook if request event not configured', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        async: false,
      });

      await webhook.beforeRequest(
        [{ role: 'user', content: 'Hello' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('afterResponse', () => {
    it('should pass through response', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: [],
      });

      const result = await webhook.afterResponse(
        'Response text',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(result.response).toBe('Response text');
    });

    it('should send webhook for response event', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        async: false,
      });

      await webhook.afterResponse(
        'Response text',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(mockFetch).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe('response');
      expect(body.agentId).toBe('agent-1');
    });

    it('should send all events when configured', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['all'],
        async: false,
      });

      await webhook.afterResponse(
        'Response',
        { agentId: 'agent-1', metadata: {} }
      );

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('notifyError', () => {
    it('should send error webhook when configured', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['error'],
      });

      await webhook.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.event).toBe('error');
      expect(body.data.error.message).toBe('Test error');
    });

    it('should not send error webhook when not configured', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
      });

      await webhook.notifyError(new Error('Test error'), {
        agentId: 'agent-1',
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('custom headers', () => {
    it('should include custom headers', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        headers: {
          'Authorization': 'Bearer my-token',
          'X-Custom': 'value',
        },
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'a', metadata: {} });

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['Authorization']).toBe('Bearer my-token');
      expect(call[1].headers['X-Custom']).toBe('value');
    });
  });

  describe('transformPayload', () => {
    it('should transform payload before sending', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        transformPayload: (payload) => ({
          custom_event: payload.event,
          custom_agent: payload.agentId,
        }),
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'agent-1', metadata: {} });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.custom_event).toBe('response');
      expect(body.custom_agent).toBe('agent-1');
    });
  });

  describe('filter', () => {
    it('should skip webhook if filter returns false', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        filter: (payload) => payload.agentId === 'important-agent',
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'regular-agent', metadata: {} });
      expect(mockFetch).not.toHaveBeenCalled();

      await webhook.afterResponse('R', { agentId: 'important-agent', metadata: {} });
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('callbacks', () => {
    it('should call onSuccess on successful delivery', async () => {
      const onSuccess = vi.fn();
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        onSuccess,
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'a', metadata: {} });

      expect(onSuccess).toHaveBeenCalled();
    });

    it('should call onError on failed delivery', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const onError = vi.fn();
      
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        onError,
        retries: 0,
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'a', metadata: {} });

      expect(onError).toHaveBeenCalled();
    });
  });

  describe('retries', () => {
    it('should retry on failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce({ ok: true });

      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        retries: 2,
        retryDelay: 10,
        async: false,
      });

      await webhook.afterResponse('R', { agentId: 'a', metadata: {} });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('content truncation', () => {
    it('should truncate long content', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        maxContentLength: 20,
        async: false,
      });

      await webhook.afterResponse(
        'This is a very long response that should be truncated',
        { agentId: 'a', metadata: {} }
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.data.output.length).toBeLessThanOrEqual(24); // 20 + "..."
    });

    it('should not include content when disabled', async () => {
      const webhook = new WebhookNotifier({
        url: 'https://api.example.com/webhooks',
        events: ['response'],
        includeContent: false,
        async: false,
      });

      await webhook.afterResponse('Secret response', { agentId: 'a', metadata: {} });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.data.output).toBeUndefined();
    });
  });
});

