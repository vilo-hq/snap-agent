import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * Trigger conditions for Discord notifications
 */
export interface DiscordTriggers {
  onError?: boolean;
  onKeywords?: string[];
  onLongResponse?: number;
  onEveryN?: number;
  custom?: (context: {
    input: string;
    output?: string;
    latency?: number;
    error?: Error;
    metadata?: Record<string, any>;
  }) => boolean;
}

/**
 * Discord embed object
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
}

/**
 * Configuration for Discord notifications
 */
export interface DiscordConfig {
  /**
   * Discord webhook URL
   */
  webhookUrl: string;

  /**
   * Trigger conditions
   */
  triggers?: DiscordTriggers;

  /**
   * Bot username shown in Discord
   * @default 'SnapAgent'
   */
  username?: string;

  /**
   * Avatar URL for the bot
   */
  avatarUrl?: string;

  /**
   * Role/user to mention on errors (e.g., '<@&ROLE_ID>' or '<@USER_ID>')
   */
  mentionOnError?: string;

  /**
   * Include full conversation context
   * @default false
   */
  includeContext?: boolean;

  /**
   * Maximum message length
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
  }) => { content?: string; embeds?: DiscordEmbed[] } | null;
}

/**
 * Discord Notifications Middleware
 * 
 * Sends notifications to Discord based on configurable triggers.
 * 
 * @example
 * ```typescript
 * import { DiscordNotifications } from '@snap-agent/middleware-discord';
 * 
 * const discord = new DiscordNotifications({
 *   webhookUrl: process.env.DISCORD_WEBHOOK_URL,
 *   triggers: {
 *     onError: true,
 *     onKeywords: ['urgent', 'help'],
 *   },
 * });
 * ```
 */
export class DiscordNotifications implements MiddlewarePlugin {
  name = 'discord-notifications';
  type = 'middleware' as const;
  priority = 200;

  private config: Required<Omit<DiscordConfig, 'formatMessage' | 'avatarUrl'>> & 
    Pick<DiscordConfig, 'formatMessage' | 'avatarUrl'>;
  private requestCounter = 0;
  private pendingMessages: Map<string, { input: string; startTime: number }> = new Map();

  constructor(config: DiscordConfig) {
    if (!config.webhookUrl) {
      throw new Error('DiscordNotifications: webhookUrl is required');
    }

    this.config = {
      webhookUrl: config.webhookUrl,
      triggers: config.triggers || { onError: true },
      username: config.username || 'SnapAgent',
      avatarUrl: config.avatarUrl,
      mentionOnError: config.mentionOnError || '',
      includeContext: config.includeContext || false,
      maxMessageLength: config.maxMessageLength || 500,
      formatMessage: config.formatMessage,
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

    return { messages, metadata: { discordRequestId: requestId } };
  }

  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    const requestId = context.metadata?.discordRequestId;
    const pending = requestId ? this.pendingMessages.get(requestId) : null;
    const latency = pending ? Date.now() - pending.startTime : 0;
    const input = pending?.input || '';

    if (requestId) {
      this.pendingMessages.delete(requestId);
    }

    this.requestCounter++;

    let shouldNotify = false;
    let trigger = '';

    if (this.config.triggers.onLongResponse && latency > this.config.triggers.onLongResponse) {
      shouldNotify = true;
      trigger = 'long_response';
    }

    if (this.config.triggers.onKeywords?.length) {
      const hasKeyword = this.config.triggers.onKeywords.some(
        (kw) => response.toLowerCase().includes(kw.toLowerCase())
      );
      if (hasKeyword) {
        shouldNotify = true;
        trigger = 'keyword';
      }
    }

    if (this.config.triggers.onEveryN && this.requestCounter % this.config.triggers.onEveryN === 0) {
      shouldNotify = true;
      trigger = 'sampling';
    }

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
      let message: { content?: string; embeds?: DiscordEmbed[] } | null;

      if (this.config.formatMessage) {
        message = this.config.formatMessage(params);
        if (!message) return;
      } else {
        message = this.formatDefaultMessage(params);
      }

      const payload: any = {
        ...message,
        username: this.config.username,
      };

      if (this.config.avatarUrl) {
        payload.avatar_url = this.config.avatarUrl;
      }

      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error('DiscordNotifications: Failed to send notification:', error);
    }
  }

  private formatDefaultMessage(params: {
    type: 'request' | 'response' | 'error';
    agentId: string;
    threadId?: string;
    input?: string;
    output?: string;
    error?: Error;
    latency?: number;
    metadata?: Record<string, any>;
  }): { content?: string; embeds?: DiscordEmbed[] } {
    const { type, agentId, threadId, input, output, error, latency, metadata } = params;
    const truncate = (str: string | undefined, max: number) => 
      str && str.length > max ? str.slice(0, max) + '...' : str;

    if (type === 'error') {
      const mention = this.config.mentionOnError ? `${this.config.mentionOnError} ` : '';
      return {
        content: `${mention}**Agent Error**`,
        embeds: [{
          title: 'Agent Error',
          color: 0xFF0000, // Red
          fields: [
            { name: 'Agent', value: agentId, inline: true },
            { name: 'Thread', value: threadId || 'N/A', inline: true },
            { name: 'Error', value: `\`\`\`${error?.message || 'Unknown error'}\`\`\`` },
            ...(this.config.includeContext && input ? [
              { name: 'User Message', value: truncate(input, this.config.maxMessageLength) || 'N/A' }
            ] : []),
          ],
          timestamp: new Date().toISOString(),
        }],
      };
    }

    const triggerLabel = metadata?.trigger === 'long_response'
      ? `Long Response (${latency}ms)`
      : metadata?.trigger === 'keyword'
      ? 'Keyword Detected'
      : 'Agent Activity';

    const color = metadata?.trigger === 'long_response' ? 0xFFA500 : 0x00FF00; // Orange or Green

    return {
      embeds: [{
        title: triggerLabel,
        color,
        fields: [
          { name: 'Agent', value: agentId, inline: true },
          { name: 'Latency', value: `${latency}ms`, inline: true },
          ...(this.config.includeContext ? [
            { name: 'User', value: truncate(input, this.config.maxMessageLength) || 'N/A' },
            { name: 'Response', value: truncate(output, this.config.maxMessageLength) || 'N/A' },
          ] : []),
        ],
        footer: { text: `Thread: ${threadId || 'N/A'}` },
        timestamp: new Date().toISOString(),
      }],
    };
  }
}

