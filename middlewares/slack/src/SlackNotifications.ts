import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * Trigger conditions for Slack notifications
 */
export interface SlackTriggers {
  /**
   * Notify when an error occurs
   * @default true
   */
  onError?: boolean;

  /**
   * Notify when these keywords are detected in input or output
   */
  onKeywords?: string[];

  /**
   * Notify when response latency exceeds this threshold (ms)
   */
  onLongResponse?: number;

  /**
   * Notify on every N-th request (for sampling)
   */
  onEveryN?: number;

  /**
   * Custom trigger function
   */
  custom?: (context: {
    input: string;
    output?: string;
    latency?: number;
    error?: Error;
    metadata?: Record<string, any>;
  }) => boolean;
}

/**
 * Slack message format
 */
export interface SlackMessage {
  text?: string;
  blocks?: any[];
  attachments?: any[];
  channel?: string;
  username?: string;
  icon_emoji?: string;
}

/**
 * Configuration for Slack notifications
 */
export interface SlackConfig {
  /**
   * Slack webhook URL
   * Get it from: https://api.slack.com/messaging/webhooks
   */
  webhookUrl: string;

  /**
   * Trigger conditions
   */
  triggers?: SlackTriggers;

  /**
   * Default channel to post to (can be overridden by webhook)
   */
  channel?: string;

  /**
   * Bot username shown in Slack
   * @default 'SnapAgent'
   */
  username?: string;

  /**
   * Emoji icon for the bot
   * @default ':robot_face:'
   */
  iconEmoji?: string;

  /**
   * User/group to mention on errors
   * e.g., '@oncall', '@channel', '<@U12345>'
   */
  mentionOnError?: string;

  /**
   * Include full conversation context in notifications
   * @default false
   */
  includeContext?: boolean;

  /**
   * Maximum message length before truncation
   * @default 500
   */
  maxMessageLength?: number;

  /**
   * Custom message formatter
   */
  formatMessage?: (context: {
    type: 'request' | 'response' | 'error';
    agentId: string;
    threadId?: string;
    input?: string;
    output?: string;
    error?: Error;
    latency?: number;
    metadata?: Record<string, any>;
  }) => SlackMessage | null;
}

/**
 * Slack Notifications Middleware
 * 
 * Sends notifications to Slack based on configurable triggers.
 * 
 * @example
 * ```typescript
 * import { SlackNotifications } from '@snap-agent/middleware-slack';
 * 
 * const slack = new SlackNotifications({
 *   webhookUrl: process.env.SLACK_WEBHOOK_URL,
 *   triggers: {
 *     onError: true,
 *     onKeywords: ['urgent', 'escalate'],
 *     onLongResponse: 5000,
 *   },
 *   mentionOnError: '@oncall',
 * });
 * 
 * const agent = await client.createAgent({
 *   plugins: [slack],
 *   // ...
 * });
 * ```
 */
export class SlackNotifications implements MiddlewarePlugin {
  name = 'slack-notifications';
  type = 'middleware' as const;
  priority = 200; // Run after other middleware

  private config: Required<Omit<SlackConfig, 'formatMessage'>> & Pick<SlackConfig, 'formatMessage'>;
  private requestCounter = 0;
  private pendingMessages: Map<string, { input: string; startTime: number }> = new Map();

  constructor(config: SlackConfig) {
    if (!config.webhookUrl) {
      throw new Error('SlackNotifications: webhookUrl is required');
    }

    this.config = {
      webhookUrl: config.webhookUrl,
      triggers: config.triggers || { onError: true },
      channel: config.channel || '',
      username: config.username || 'SnapAgent',
      iconEmoji: config.iconEmoji || ':robot_face:',
      mentionOnError: config.mentionOnError || '',
      includeContext: config.includeContext || false,
      maxMessageLength: config.maxMessageLength || 500,
      formatMessage: config.formatMessage,
    };
  }

  /**
   * Before request hook - track request for potential notification
   */
  async beforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string }
  ): Promise<{ messages: any[]; metadata?: any }> {
    const requestId = `${context.agentId}-${Date.now()}`;
    const lastMessage = messages[messages.length - 1];
    const input = typeof lastMessage === 'string' 
      ? lastMessage 
      : lastMessage?.content || '';

    // Store request info for afterResponse
    this.pendingMessages.set(requestId, {
      input,
      startTime: Date.now(),
    });

    // Check keyword triggers on input
    if (this.config.triggers.onKeywords?.length) {
      const hasKeyword = this.config.triggers.onKeywords.some(
        (kw) => input.toLowerCase().includes(kw.toLowerCase())
      );
      if (hasKeyword) {
        await this.sendNotification({
          type: 'request',
          agentId: context.agentId,
          threadId: context.threadId,
          input,
          metadata: { trigger: 'keyword' },
        });
      }
    }

    return { 
      messages, 
      metadata: { slackRequestId: requestId } 
    };
  }

  /**
   * After response hook - check triggers and send notifications
   */
  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    const requestId = context.metadata?.slackRequestId;
    const pending = requestId ? this.pendingMessages.get(requestId) : null;
    const latency = pending ? Date.now() - pending.startTime : 0;
    const input = pending?.input || '';

    // Clean up pending message
    if (requestId) {
      this.pendingMessages.delete(requestId);
    }

    // Increment request counter
    this.requestCounter++;

    let shouldNotify = false;
    let trigger = '';

    // Check long response trigger
    if (this.config.triggers.onLongResponse && latency > this.config.triggers.onLongResponse) {
      shouldNotify = true;
      trigger = 'long_response';
    }

    // Check keyword triggers on output
    if (this.config.triggers.onKeywords?.length) {
      const hasKeyword = this.config.triggers.onKeywords.some(
        (kw) => response.toLowerCase().includes(kw.toLowerCase())
      );
      if (hasKeyword) {
        shouldNotify = true;
        trigger = 'keyword';
      }
    }

    // Check every N requests trigger
    if (this.config.triggers.onEveryN && this.requestCounter % this.config.triggers.onEveryN === 0) {
      shouldNotify = true;
      trigger = 'sampling';
    }

    // Check custom trigger
    if (this.config.triggers.custom) {
      const customResult = this.config.triggers.custom({
        input,
        output: response,
        latency,
        metadata: context.metadata,
      });
      if (customResult) {
        shouldNotify = true;
        trigger = 'custom';
      }
    }

    if (shouldNotify) {
      await this.sendNotification({
        type: 'response',
        agentId: context.agentId,
        threadId: context.threadId,
        input,
        output: response,
        latency,
        metadata: { trigger, ...context.metadata },
      });
    }

    return { response, metadata: context.metadata };
  }

  /**
   * Send an error notification (can be called externally)
   */
  async notifyError(error: Error, context: {
    agentId: string;
    threadId?: string;
    input?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    if (!this.config.triggers.onError) return;

    await this.sendNotification({
      type: 'error',
      agentId: context.agentId,
      threadId: context.threadId,
      input: context.input,
      error,
      metadata: context.metadata,
    });
  }

  /**
   * Send notification to Slack
   */
  private async sendNotification(params: {
    type: 'request' | 'response' | 'error';
    agentId: string;
    threadId?: string;
    input?: string;
    output?: string;
    error?: Error;
    latency?: number;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      let message: SlackMessage | null;

      // Use custom formatter if provided
      if (this.config.formatMessage) {
        message = this.config.formatMessage(params);
        if (!message) return;
      } else {
        message = this.formatDefaultMessage(params);
      }

      // Add default fields
      if (this.config.channel && !message.channel) {
        message.channel = this.config.channel;
      }
      if (!message.username) {
        message.username = this.config.username;
      }
      if (!message.icon_emoji) {
        message.icon_emoji = this.config.iconEmoji;
      }

      // Send to Slack
      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
    } catch (error) {
      console.error('SlackNotifications: Failed to send notification:', error);
    }
  }

  /**
   * Format default Slack message
   */
  private formatDefaultMessage(params: {
    type: 'request' | 'response' | 'error';
    agentId: string;
    threadId?: string;
    input?: string;
    output?: string;
    error?: Error;
    latency?: number;
    metadata?: Record<string, any>;
  }): SlackMessage {
    const { type, agentId, threadId, input, output, error, latency, metadata } = params;
    const truncate = (str: string | undefined, max: number) => 
      str && str.length > max ? str.slice(0, max) + '...' : str;

    if (type === 'error') {
      const mention = this.config.mentionOnError ? `${this.config.mentionOnError} ` : '';
      return {
        text: `${mention}*Agent Error*`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Agent Error', emoji: false },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Agent:*\n${agentId}` },
              { type: 'mrkdwn', text: `*Thread:*\n${threadId || 'N/A'}` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Error:*\n\`\`\`${error?.message || 'Unknown error'}\`\`\``,
            },
          },
          ...(this.config.includeContext && input ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*User Message:*\n${truncate(input, this.config.maxMessageLength)}`,
            },
          }] : []),
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Timestamp: ${new Date().toISOString()}` },
            ],
          },
        ],
      };
    }

    // Response notification (keyword, long response, etc.)
    const triggerLabel = metadata?.trigger === 'long_response'
      ? `Long Response (${latency}ms)`
      : metadata?.trigger === 'keyword'
      ? 'Keyword Detected'
      : 'Agent Activity';

    return {
      text: triggerLabel,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: triggerLabel, emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Agent:*\n${agentId}` },
            { type: 'mrkdwn', text: `*Latency:*\n${latency}ms` },
          ],
        },
        ...(this.config.includeContext ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*User:*\n${truncate(input, this.config.maxMessageLength)}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Agent:*\n${truncate(output, this.config.maxMessageLength)}`,
            },
          },
        ] : []),
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Thread: ${threadId || 'N/A'} | ${new Date().toISOString()}` },
          ],
        },
      ],
    };
  }
}

