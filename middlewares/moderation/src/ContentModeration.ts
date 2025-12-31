import type { MiddlewarePlugin } from '@snap-agent/core';

/**
 * Types of PII that can be detected
 */
export type PIIType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'ip_address'
  | 'address'
  | 'name';

/**
 * Action to take on violation
 */
export type ViolationAction =
  | 'block'     // Reject the message entirely
  | 'mask'      // Replace sensitive content with [REDACTED]
  | 'warn'      // Allow but log a warning
  | 'flag';     // Allow but add metadata flag

/**
 * Result of moderation check
 */
export interface ModerationResult {
  passed: boolean;
  violations: Array<{
    type: 'pii' | 'profanity' | 'blocked_topic' | 'custom';
    subType?: string;
    text: string;
    position: { start: number; end: number };
    action: ViolationAction;
  }>;
  moderatedText?: string;
}

/**
 * Configuration for content moderation
 */
export interface ModerationConfig {
  /**
   * Detect and handle PII (Personally Identifiable Information)
   */
  detectPII?: {
    enabled: boolean;
    types?: PIIType[];
    action?: ViolationAction;
    /**
     * Custom regex patterns for PII detection
     */
    customPatterns?: Array<{
      name: string;
      pattern: RegExp;
    }>;
  };

  /**
   * Filter profanity
   */
  profanityFilter?: {
    enabled: boolean;
    action?: ViolationAction;
    /**
     * Additional words to filter
     */
    customWords?: string[];
    /**
     * Words to allow (whitelist)
     */
    allowList?: string[];
  };

  /**
   * Block specific topics
   */
  blockedTopics?: {
    enabled: boolean;
    topics: string[];
    action?: ViolationAction;
  };

  /**
   * Apply moderation to input (user messages)
   * @default true
   */
  moderateInput?: boolean;

  /**
   * Apply moderation to output (agent responses)
   * @default true
   */
  moderateOutput?: boolean;

  /**
   * Custom moderation function
   */
  customModerator?: (text: string, direction: 'input' | 'output') => Promise<ModerationResult>;

  /**
   * Callback when content is blocked
   */
  onBlock?: (result: ModerationResult, context: {
    agentId: string;
    threadId?: string;
    direction: 'input' | 'output';
  }) => void;

  /**
   * Message to return when input is blocked
   * @default "I'm unable to process that request."
   */
  blockedInputMessage?: string;

  /**
   * Message to return when output is blocked (before reaching user)
   * @default "I apologize, but I cannot provide that response."
   */
  blockedOutputMessage?: string;
}

// Common profanity list (basic, needs a more comprehensive list in production.)
const DEFAULT_PROFANITY = [
  'damn', 'hell', 'ass', 'shit', 'fuck', 'bitch', 'bastard',
  // Add more as needed using the customWords option (config.profanityFilter.customWords).
];

// PII regex patterns
const PII_PATTERNS: Record<PIIType, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  phone: /(\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  ip_address: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  address: /\d+\s+[\w\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|circle|cir)\b/gi,
  name: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, // Simple name pattern
};

/**
 * Content Moderation Middleware
 * 
 * Provides safety guardrails for AI agents:
 * - PII detection and masking
 * - Profanity filtering
 * - Blocked topic detection
 * - Custom moderation rules
 * 
 * @example
 * ```typescript
 * import { ContentModeration } from '@snap-agent/middleware-moderation';
 * 
 * const moderation = new ContentModeration({
 *   detectPII: {
 *     enabled: true,
 *     types: ['email', 'phone', 'ssn', 'credit_card'],
 *     action: 'mask',
 *   },
 *   profanityFilter: {
 *     enabled: true,
 *     action: 'mask',
 *   },
 *   blockedTopics: {
 *     enabled: true,
 *     topics: ['violence', 'illegal activities'],
 *     action: 'block',
 *   },
 * });
 * ```
 */
export class ContentModeration implements MiddlewarePlugin {
  name = 'content-moderation';
  type = 'middleware' as const;
  priority = 10; // Run early

  private config: ModerationConfig;
  private profanitySet: Set<string>;

  constructor(config: ModerationConfig = {}) {
    this.config = {
      moderateInput: config.moderateInput !== false,
      moderateOutput: config.moderateOutput !== false,
      blockedInputMessage: config.blockedInputMessage || "I'm unable to process that request.",
      blockedOutputMessage: config.blockedOutputMessage || "I apologize, but I cannot provide that response.",
      ...config,
    };

    // Build profanity set
    const profanityWords = [...DEFAULT_PROFANITY];
    if (config.profanityFilter?.customWords) {
      profanityWords.push(...config.profanityFilter.customWords);
    }
    if (config.profanityFilter?.allowList) {
      config.profanityFilter.allowList.forEach((word) => {
        const idx = profanityWords.indexOf(word.toLowerCase());
        if (idx > -1) profanityWords.splice(idx, 1);
      });
    }
    this.profanitySet = new Set(profanityWords.map((w) => w.toLowerCase()));
  }

  async beforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string }
  ): Promise<{ messages: any[]; metadata?: any }> {
    if (!this.config.moderateInput) {
      return { messages };
    }

    const lastMessage = messages[messages.length - 1];
    const content = typeof lastMessage === 'string'
      ? lastMessage
      : lastMessage?.content || '';

    const result = await this.moderate(content, 'input');

    if (!result.passed) {
      const hasBlock = result.violations.some((v) => v.action === 'block');

      if (hasBlock) {
        this.config.onBlock?.(result, {
          agentId: context.agentId,
          threadId: context.threadId,
          direction: 'input',
        });

        // Replace the message with blocked message
        const newMessages = [...messages];
        const blockedMessage = typeof lastMessage === 'string'
          ? this.config.blockedInputMessage!
          : { ...lastMessage, content: this.config.blockedInputMessage! };
        newMessages[newMessages.length - 1] = blockedMessage;

        return {
          messages: newMessages,
          metadata: { moderation: { blocked: true, result } },
        };
      }

      // Apply masking if needed
      if (result.moderatedText && result.moderatedText !== content) {
        const newMessages = [...messages];
        const maskedMessage = typeof lastMessage === 'string'
          ? result.moderatedText
          : { ...lastMessage, content: result.moderatedText };
        newMessages[newMessages.length - 1] = maskedMessage;

        return {
          messages: newMessages,
          metadata: { moderation: { masked: true, result } },
        };
      }
    }

    return { messages, metadata: { moderation: { passed: true } } };
  }

  async afterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    if (!this.config.moderateOutput) {
      return { response, metadata: context.metadata };
    }

    const result = await this.moderate(response, 'output');

    if (!result.passed) {
      const hasBlock = result.violations.some((v) => v.action === 'block');

      if (hasBlock) {
        this.config.onBlock?.(result, {
          agentId: context.agentId,
          threadId: context.threadId,
          direction: 'output',
        });

        return {
          response: this.config.blockedOutputMessage!,
          metadata: { ...context.metadata, moderation: { blocked: true, result } },
        };
      }

      // Apply masking if needed
      if (result.moderatedText) {
        return {
          response: result.moderatedText,
          metadata: { ...context.metadata, moderation: { masked: true, result } },
        };
      }
    }

    return { response, metadata: { ...context.metadata, moderation: { passed: true } } };
  }

  /**
   * Moderate text content
   */
  private async moderate(text: string, direction: 'input' | 'output'): Promise<ModerationResult> {
    // Use custom moderator if provided
    if (this.config.customModerator) {
      return this.config.customModerator(text, direction);
    }

    const violations: ModerationResult['violations'] = [];
    let moderatedText = text;

    // Check PII
    if (this.config.detectPII?.enabled) {
      const piiTypes = this.config.detectPII.types || ['email', 'phone', 'ssn', 'credit_card'];
      const piiAction = this.config.detectPII.action || 'mask';

      for (const piiType of piiTypes) {
        const pattern = PII_PATTERNS[piiType];
        if (pattern) {
          let match;
          const regex = new RegExp(pattern.source, pattern.flags);
          while ((match = regex.exec(text)) !== null) {
            violations.push({
              type: 'pii',
              subType: piiType,
              text: match[0],
              position: { start: match.index, end: match.index + match[0].length },
              action: piiAction,
            });

            if (piiAction === 'mask') {
              moderatedText = moderatedText.replace(match[0], '[REDACTED]');
            }
          }
        }
      }

      // Custom PII patterns
      if (this.config.detectPII.customPatterns) {
        for (const { name, pattern } of this.config.detectPII.customPatterns) {
          let match;
          const regex = new RegExp(pattern.source, pattern.flags);
          while ((match = regex.exec(text)) !== null) {
            violations.push({
              type: 'pii',
              subType: name,
              text: match[0],
              position: { start: match.index, end: match.index + match[0].length },
              action: piiAction,
            });

            if (piiAction === 'mask') {
              moderatedText = moderatedText.replace(match[0], '[REDACTED]');
            }
          }
        }
      }
    }

    // Check profanity
    if (this.config.profanityFilter?.enabled) {
      const profanityAction = this.config.profanityFilter.action || 'mask';
      const words = text.split(/\s+/);

      for (let i = 0; i < words.length; i++) {
        const word = words[i].toLowerCase().replace(/[^a-z]/g, '');
        if (this.profanitySet.has(word)) {
          const startIdx = text.toLowerCase().indexOf(word);
          violations.push({
            type: 'profanity',
            text: words[i],
            position: { start: startIdx, end: startIdx + words[i].length },
            action: profanityAction,
          });

          if (profanityAction === 'mask') {
            moderatedText = moderatedText.replace(
              new RegExp(`\\b${word}\\b`, 'gi'),
              '*'.repeat(word.length)
            );
          }
        }
      }
    }

    // Check blocked topics
    if (this.config.blockedTopics?.enabled) {
      const topicAction = this.config.blockedTopics.action || 'block';
      const lowerText = text.toLowerCase();

      for (const topic of this.config.blockedTopics.topics) {
        if (lowerText.includes(topic.toLowerCase())) {
          const startIdx = lowerText.indexOf(topic.toLowerCase());
          violations.push({
            type: 'blocked_topic',
            subType: topic,
            text: topic,
            position: { start: startIdx, end: startIdx + topic.length },
            action: topicAction,
          });
        }
      }
    }

    const hasBlockAction = violations.some((v) => v.action === 'block');

    return {
      passed: violations.length === 0,
      violations,
      moderatedText: hasBlockAction ? undefined : moderatedText,
    };
  }

  /**
   * Manually check content without blocking
   */
  async check(text: string): Promise<ModerationResult> {
    return this.moderate(text, 'input');
  }
}

