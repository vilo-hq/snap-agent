import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * Event types that can trigger webhooks
 */
export type WebhookEvent = 
  | 'request'      // When a request is made
  | 'response'     // When a response is received
  | 'error'        // When an error occurs
  | 'all';         // All events

/**
 * Payload sent to the webhook
 */
export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  data: {
    input?: string;
    output?: string;
    latency?: number;
    error?: {
      message: string;
      stack?: string;
    };
    tokens?: number;
    model?: string;
    provider?: string;
  };
  metadata?: Record<string, any>;
}

/**
 * Configuration for webhook notifier
 */
export interface WebhookConfig {
  /**
   * Webhook URL to send events to
   */
  url: string;

  /**
   * Events to send
   * @default ['response', 'error']
   */
  events?: WebhookEvent[];

  /**
   * HTTP headers to include
   */
  headers?: Record<string, string>;

  /**
   * HTTP method
   * @default 'POST'
   */
  method?: 'POST' | 'PUT';

  /**
   * Timeout in ms
   * @default 5000
   */
  timeout?: number;

  /**
   * Number of retries on failure
   * @default 2
   */
  retries?: number;

  /**
   * Retry delay in ms
   * @default 1000
   */
  retryDelay?: number;

  /**
   * Include full message content
   * @default true
   */
  includeContent?: boolean;

  /**
   * Maximum content length before truncation
   * @default 1000
   */
  maxContentLength?: number;

  /**
   * Custom payload transformer
   */
  transformPayload?: (payload: WebhookPayload) => any;

  /**
   * Filter function to decide whether to send webhook
   */
  filter?: (payload: WebhookPayload) => boolean;

  /**
   * Callback on successful delivery
   */
  onSuccess?: (payload: WebhookPayload, response: Response) => void;

  /**
   * Callback on failed delivery
   */
  onError?: (payload: WebhookPayload, error: Error) => void;

  /**
   * Send webhooks asynchronously (don't block response)
   * @default true
   */
  async?: boolean;
}

/**
 * Webhook Notifier Middleware
 * 
 * Sends agent events to any HTTP endpoint. Perfect for:
 * - Custom analytics systems
 * - Event logging
 * - Third-party integrations
 * - Automation triggers
 * 
 * @example
 * ```typescript
 * import { WebhookNotifier } from '@snap-agent/middleware-webhooks';
 * 
 * const webhook = new WebhookNotifier({
 *   url: 'https://your-api.com/agent-events',
 *   events: ['response', 'error'],
 *   headers: {
 *     'Authorization': 'Bearer your-token',
 *   },
 * });
 * ```
 */
export class WebhookNotifier implements MiddlewarePlugin {
  name = 'webhook-notifier';
  type = 'middleware' as const;
  priority = 200;

  private config: Required<Omit<WebhookConfig, 'transformPayload' | 'filter' | 'onSuccess' | 'onError'>> & 
    Pick<WebhookConfig, 'transformPayload' | 'filter' | 'onSuccess' | 'onError'>;
  private pendingMessages: Map<string, { input: string; startTime: number }> = new Map();

  constructor(config: WebhookConfig) {
    if (!config.url) {
      throw new Error('WebhookNotifier: url is required');
    }

    this.config = {
      url: config.url,
      events: config.events || ['response', 'error'],
      headers: config.headers || {},
      method: config.method || 'POST',
      timeout: config.timeout || 5000,
      retries: config.retries ?? 2,
      retryDelay: config.retryDelay || 1000,
      includeContent: config.includeContent !== false,
      maxContentLength: config.maxContentLength || 1000,
      transformPayload: config.transformPayload,
      filter: config.filter,
      onSuccess: config.onSuccess,
      onError: config.onError,
      async: config.async !== false,
    };
  }

  async beforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string }
  ): Promise<{ messages: any[]; metadata?: any }> {
    const requestId = `${context.agentId}-${Date.now()}`;
    const lastMessage = messages[messages.length - 1];
    const input = typeof lastMessage === 'string' 
      ? lastMessage 
      : lastMessage?.content || '';

    this.pendingMessages.set(requestId, {
      input,
      startTime: Date.now(),
    });

    // Send request event if configured
    if (this.shouldSendEvent('request')) {
      const payload = this.createPayload('request', {
        agentId: context.agentId,
        threadId: context.threadId,
        input,
      });

      if (this.config.async) {
        this.sendWebhook(payload).catch(() => {});
      } else {
        await this.sendWebhook(payload);
      }
    }

    return { messages, metadata: { webhookRequestId: requestId } };
  }

  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    const requestId = context.metadata?.webhookRequestId;
    const pending = requestId ? this.pendingMessages.get(requestId) : null;
    const latency = pending ? Date.now() - pending.startTime : 0;
    const input = pending?.input || '';

    if (requestId) {
      this.pendingMessages.delete(requestId);
    }

    if (this.shouldSendEvent('response')) {
      const payload = this.createPayload('response', {
        agentId: context.agentId,
        threadId: context.threadId,
        input,
        output: response,
        latency,
        metadata: context.metadata,
      });

      if (this.config.async) {
        this.sendWebhook(payload).catch(() => {});
      } else {
        await this.sendWebhook(payload);
      }
    }

    return { response, metadata: context.metadata };
  }

  /**
   * Send error webhook (can be called externally)
   */
  async notifyError(error: Error, context: {
    agentId: string;
    threadId?: string;
    input?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    if (!this.shouldSendEvent('error')) return;

    const payload = this.createPayload('error', {
      agentId: context.agentId,
      threadId: context.threadId,
      input: context.input,
      error,
      metadata: context.metadata,
    });

    await this.sendWebhook(payload);
  }

  private shouldSendEvent(event: WebhookEvent): boolean {
    return this.config.events.includes(event) || this.config.events.includes('all');
  }

  private createPayload(
    event: WebhookEvent,
    data: {
      agentId: string;
      threadId?: string;
      input?: string;
      output?: string;
      latency?: number;
      error?: Error;
      metadata?: Record<string, any>;
    }
  ): WebhookPayload {
    const truncate = (str: string | undefined) => {
      if (!str || !this.config.includeContent) return undefined;
      return str.length > this.config.maxContentLength 
        ? str.slice(0, this.config.maxContentLength) + '...'
        : str;
    };

    return {
      event,
      timestamp: new Date().toISOString(),
      agentId: data.agentId,
      threadId: data.threadId,
      data: {
        input: truncate(data.input),
        output: truncate(data.output),
        latency: data.latency,
        error: data.error ? {
          message: data.error.message,
          stack: data.error.stack,
        } : undefined,
      },
      metadata: data.metadata,
    };
  }

  private async sendWebhook(payload: WebhookPayload): Promise<void> {
    // Apply filter
    if (this.config.filter && !this.config.filter(payload)) {
      return;
    }

    // Transform payload if needed
    const body = this.config.transformPayload 
      ? this.config.transformPayload(payload)
      : payload;

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(this.config.url, {
          method: this.config.method,
          headers: {
            'Content-Type': 'application/json',
            ...this.config.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          this.config.onSuccess?.(payload, response);
          return;
        }

        lastError = new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Wait before retry
      if (attempt < this.config.retries) {
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelay));
      }
    }

    // All retries failed
    if (lastError) {
      console.error('WebhookNotifier: Failed to send webhook:', lastError);
      this.config.onError?.(payload, lastError);
    }
  }
}

