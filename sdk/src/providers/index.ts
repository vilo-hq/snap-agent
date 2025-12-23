import { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ProviderType, ProviderConfig, ProviderNotFoundError } from '../types';

/**
 * Provider factory for creating language model instances
 * Supports OpenAI, Anthropic, and Google providers via Vercel AI SDK
 */
export class ProviderFactory {
  private config: ProviderConfig;
  private modelCache: Map<string, LanguageModel> = new Map();

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Get a language model for the specified provider and model
   * Uses dynamic imports for edge runtime compatibility
   */
  async getModel(provider: ProviderType, modelName: string): Promise<LanguageModel> {
    const cacheKey = `${provider}:${modelName}`;

    if (this.modelCache.has(cacheKey)) {
      return this.modelCache.get(cacheKey)!;
    }

    let model: LanguageModel;

    switch (provider) {
      case 'openai': {
        if (!this.config.openai?.apiKey) {
          throw new ProviderNotFoundError('OpenAI API key not configured');
        }
        const openai = createOpenAI({
          apiKey: this.config.openai.apiKey,
        });
        model = openai(modelName);
        break;
      }

      case 'anthropic': {
        if (!this.config.anthropic?.apiKey) {
          throw new ProviderNotFoundError('Anthropic API key not configured');
        }
        // Dynamic import for edge runtime compatibility
        try {
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          const anthropic = createAnthropic({
            apiKey: this.config.anthropic.apiKey,
          });
          model = anthropic(modelName);
        } catch (error) {
          throw new ProviderNotFoundError(
            'Anthropic provider not installed. Run: npm install @ai-sdk/anthropic'
          );
        }
        break;
      }

      case 'google': {
        if (!this.config.google?.apiKey) {
          throw new ProviderNotFoundError('Google API key not configured');
        }
        // Dynamic import for edge runtime compatibility
        try {
          const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
          const google = createGoogleGenerativeAI({
            apiKey: this.config.google.apiKey,
          });
          model = google(modelName);
        } catch (error) {
          throw new ProviderNotFoundError(
            'Google provider not installed. Run: npm install @ai-sdk/google'
          );
        }
        break;
      }

      default:
        throw new ProviderNotFoundError(`Unknown provider: ${provider}`);
    }

    this.modelCache.set(cacheKey, model);
    return model;
  }

  /**
   * Check if a provider is configured
   */
  isProviderConfigured(provider: ProviderType): boolean {
    switch (provider) {
      case 'openai':
        return !!this.config.openai?.apiKey;
      case 'anthropic':
        return !!this.config.anthropic?.apiKey;
      case 'google':
        return !!this.config.google?.apiKey;
      default:
        return false;
    }
  }

  /**
   * Get list of configured providers
   */
  getConfiguredProviders(): ProviderType[] {
    const providers: ProviderType[] = [];

    if (this.config.openai?.apiKey) providers.push('openai');
    if (this.config.anthropic?.apiKey) providers.push('anthropic');
    if (this.config.google?.apiKey) providers.push('google');

    return providers;
  }

  /**
   * Clear the model cache
   */
  clearCache(): void {
    this.modelCache.clear();
  }
}

/**
 * Common model names for quick reference
 */
export const Models = {
  OpenAI: {
    GPT4O: 'gpt-4o',
    GPT4O_MINI: 'gpt-4o-mini',
    GPT4_TURBO: 'gpt-4-turbo',
    GPT35_TURBO: 'gpt-3.5-turbo',
  },
  Anthropic: {
    CLAUDE_35_SONNET: 'claude-3-5-sonnet-20241022',
    CLAUDE_35_HAIKU: 'claude-3-5-haiku-20241022',
    CLAUDE_3_OPUS: 'claude-3-opus-20240229',
  },
  Google: {
    GEMINI_2_FLASH: 'gemini-2.0-flash-exp',
    GEMINI_15_PRO: 'gemini-1.5-pro',
    GEMINI_15_FLASH: 'gemini-1.5-flash',
  },
} as const;

