import type { AnalyticsPlugin } from '@snap-agent/core';

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'minimal' | 'standard' | 'verbose';

export interface ConsoleAnalyticsConfig {
  /**
   * Log level
   * - minimal: Just request/response counts
   * - standard: Include latency and tokens
   * - verbose: Include all details
   * @default 'standard'
   */
  level?: LogLevel;

  /**
   * Enable colored output
   * @default true
   */
  colors?: boolean;

  /**
   * Show timestamps
   * @default true
   */
  timestamps?: boolean;

  /**
   * Prefix for log messages
   * @default '[SnapAgent]'
   */
  prefix?: string;

  /**
   * Log requests
   * @default true
   */
  logRequests?: boolean;

  /**
   * Log responses
   * @default true
   */
  logResponses?: boolean;

  /**
   * Log errors
   * @default true
   */
  logErrors?: boolean;

  /**
   * Show periodic summaries (interval in ms, 0 = disabled)
   * @default 0
   */
  summaryInterval?: number;
}

// ============================================================================
// Console Analytics Plugin
// ============================================================================

/**
 * Console Analytics Plugin
 * 
 * Simple plugin that pretty-prints analytics to the console.
 * Perfect for development and debugging.
 */
export class ConsoleAnalytics implements AnalyticsPlugin {
  name = 'console-analytics';
  type = 'analytics' as const;

  private config: Required<ConsoleAnalyticsConfig>;
  private requestCount = 0;
  private responseCount = 0;
  private errorCount = 0;
  private totalLatency = 0;
  private totalTokens = 0;
  private summaryTimer?: NodeJS.Timeout;

  constructor(config: ConsoleAnalyticsConfig = {}) {
    this.config = {
      level: config.level || 'standard',
      colors: config.colors !== false,
      timestamps: config.timestamps !== false,
      prefix: config.prefix || '[SnapAgent]',
      logRequests: config.logRequests !== false,
      logResponses: config.logResponses !== false,
      logErrors: config.logErrors !== false,
      summaryInterval: config.summaryInterval || 0,
    };

    if (this.config.summaryInterval > 0) {
      this.summaryTimer = setInterval(
        () => this.printSummary(),
        this.config.summaryInterval
      );
    }
  }

  // ============================================================================
  // Plugin Interface
  // ============================================================================

  async trackRequest(data: {
    agentId: string;
    threadId?: string;
    message: string;
    timestamp: Date;
  }): Promise<void> {
    this.requestCount++;

    if (!this.config.logRequests) return;

    const parts: string[] = [];

    // Timestamp
    if (this.config.timestamps) {
      parts.push(this.dim(`[${this.formatTime(data.timestamp)}]`));
    }

    // Prefix
    parts.push(this.config.prefix);

    // Icon and label
    parts.push(this.cyan('→ Request'));

    // Details based on level
    if (this.config.level !== 'minimal') {
      parts.push(this.dim(`agent:${data.agentId.slice(0, 8)}`));
      if (data.threadId) {
        parts.push(this.dim(`thread:${data.threadId.slice(0, 8)}`));
      }
    }

    if (this.config.level === 'verbose') {
      parts.push(`\n  ${this.dim('Message:')} ${this.truncate(data.message, 100)}`);
    }

    console.log(parts.join(' '));
  }

  async trackResponse(data: {
    agentId: string;
    threadId?: string;
    response: string;
    latency: number;
    tokensUsed?: number;
    timestamp: Date;
  }): Promise<void> {
    this.responseCount++;
    this.totalLatency += data.latency;
    this.totalTokens += data.tokensUsed || 0;

    if (!this.config.logResponses) return;

    const parts: string[] = [];

    // Timestamp
    if (this.config.timestamps) {
      parts.push(this.dim(`[${this.formatTime(data.timestamp)}]`));
    }

    // Prefix
    parts.push(this.config.prefix);

    // Icon and label
    parts.push(this.green('← Response'));

    // Latency
    const latencyColor = data.latency < 500 ? 'green' : data.latency < 2000 ? 'yellow' : 'red';
    parts.push(this[latencyColor](`${data.latency}ms`));

    // Tokens
    if (this.config.level !== 'minimal' && data.tokensUsed) {
      parts.push(this.dim(`${data.tokensUsed} tokens`));
    }

    // Details
    if (this.config.level !== 'minimal') {
      parts.push(this.dim(`agent:${data.agentId.slice(0, 8)}`));
    }

    if (this.config.level === 'verbose') {
      parts.push(`\n  ${this.dim('Response:')} ${this.truncate(data.response, 150)}`);
    }

    console.log(parts.join(' '));
  }

  // ============================================================================
  // Extended Tracking (Optional)
  // ============================================================================

  async trackError(data: {
    agentId: string;
    threadId?: string;
    timestamp: Date;
    errorType: string;
    errorMessage: string;
  }): Promise<void> {
    this.errorCount++;

    if (!this.config.logErrors) return;

    const parts: string[] = [];

    // Timestamp
    if (this.config.timestamps) {
      parts.push(this.dim(`[${this.formatTime(data.timestamp)}]`));
    }

    // Prefix
    parts.push(this.config.prefix);

    // Icon and label
    parts.push(this.red('x Error'));
    parts.push(this.red(data.errorType));

    if (this.config.level !== 'minimal') {
      parts.push(this.dim(`agent:${data.agentId.slice(0, 8)}`));
    }

    if (this.config.level === 'verbose') {
      parts.push(`\n  ${this.dim('Message:')} ${data.errorMessage}`);
    }

    console.log(parts.join(' '));
  }

  // ============================================================================
  // Summary
  // ============================================================================

  printSummary(): void {
    const avgLatency = this.responseCount > 0 
      ? Math.round(this.totalLatency / this.responseCount) 
      : 0;
    
    const avgTokens = this.responseCount > 0
      ? Math.round(this.totalTokens / this.responseCount)
      : 0;

    console.log('');
    console.log(this.bold(`${this.config.prefix} Summary`));
    console.log(this.dim('─'.repeat(40)));
    console.log(`  Requests:      ${this.cyan(this.requestCount.toString())}`);
    console.log(`  Responses:     ${this.green(this.responseCount.toString())}`);
    console.log(`  Errors:        ${this.errorCount > 0 ? this.red(this.errorCount.toString()) : this.dim('0')}`);
    console.log(`  Avg Latency:   ${this.formatLatency(avgLatency)}`);
    console.log(`  Avg Tokens:    ${this.dim(avgTokens.toString())}`);
    console.log(`  Total Tokens:  ${this.dim(this.totalTokens.toString())}`);
    console.log(this.dim('─'.repeat(40)));
    console.log('');
  }

  /**
   * Reset counters
   */
  reset(): void {
    this.requestCount = 0;
    this.responseCount = 0;
    this.errorCount = 0;
    this.totalLatency = 0;
    this.totalTokens = 0;
  }

  /**
   * Get current stats
   */
  getStats(): Record<string, number> {
    return {
      requests: this.requestCount,
      responses: this.responseCount,
      errors: this.errorCount,
      avgLatency: this.responseCount > 0 
        ? Math.round(this.totalLatency / this.responseCount) 
        : 0,
      totalTokens: this.totalTokens,
    };
  }

  /**
   * Stop summary timer
   */
  destroy(): void {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
    }
  }

  // ============================================================================
  // Formatting Helpers
  // ============================================================================

  private formatTime(date: Date): string {
    return date.toISOString().slice(11, 23);
  }

  private truncate(str: string, maxLen: number): string {
    const cleaned = str.replace(/\n/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return cleaned.slice(0, maxLen - 3) + '...';
  }

  private formatLatency(ms: number): string {
    if (ms < 500) return this.green(`${ms}ms`);
    if (ms < 2000) return this.yellow(`${ms}ms`);
    return this.red(`${ms}ms`);
  }

  // ============================================================================
  // Color Helpers
  // ============================================================================

  private bold(text: string): string {
    return this.config.colors ? `\x1b[1m${text}\x1b[0m` : text;
  }

  private dim(text: string): string {
    return this.config.colors ? `\x1b[2m${text}\x1b[0m` : text;
  }

  private green(text: string): string {
    return this.config.colors ? `\x1b[32m${text}\x1b[0m` : text;
  }

  private yellow(text: string): string {
    return this.config.colors ? `\x1b[33m${text}\x1b[0m` : text;
  }

  private red(text: string): string {
    return this.config.colors ? `\x1b[31m${text}\x1b[0m` : text;
  }

  private cyan(text: string): string {
    return this.config.colors ? `\x1b[36m${text}\x1b[0m` : text;
  }
}

