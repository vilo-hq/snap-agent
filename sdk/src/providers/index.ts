import { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ProviderType, ProviderConfig, ProviderNotFoundError } from '../types';

/**
 * Provider factory for creating language model instances
 * Supports OpenAI, Anthropic, Google, and Hugging Face providers via Vercel AI SDK
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

      case 'huggingface': {
        if (!this.config.huggingface?.apiKey) {
          throw new ProviderNotFoundError('Hugging Face API key not configured');
        }
        // Dynamic import for edge runtime compatibility
        try {
          const { createHuggingFace } = await import('@ai-sdk/huggingface');
          const huggingface = createHuggingFace({
            apiKey: this.config.huggingface.apiKey,
          });
          model = huggingface(modelName);
        } catch (error) {
          throw new ProviderNotFoundError(
            'Hugging Face provider not installed. Run: npm install @ai-sdk/huggingface'
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
      case 'huggingface':
        return !!this.config.huggingface?.apiKey;
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
    if (this.config.huggingface?.apiKey) providers.push('huggingface');

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
 * Updated: February 2026
 */
export const Models = {
  OpenAI: {
    // GPT-5 series (latest)
    GPT5: 'gpt-5',
    GPT5_MINI: 'gpt-5-mini',
    // GPT-4o series (stable)
    GPT4O: 'gpt-4o',
    GPT4O_MINI: 'gpt-4o-mini',
    // Reasoning models
    O1: 'o1',
    O1_MINI: 'o1-mini',
  },
  Anthropic: {
    // Claude 4 series (latest)
    CLAUDE_4_OPUS: 'claude-opus-4-20250514',
    CLAUDE_4_SONNET: 'claude-sonnet-4-20250514',
    // Claude 3.7 series
    CLAUDE_37_SONNET: 'claude-3-7-sonnet-latest',
    // Claude 3.5 series (stable)
    CLAUDE_35_SONNET: 'claude-3-5-sonnet-latest',
    CLAUDE_35_HAIKU: 'claude-3-5-haiku-latest',
  },
  Google: {
    // Gemini 2.0 series (latest)
    GEMINI_2_FLASH: 'gemini-2.0-flash',
    GEMINI_2_FLASH_LITE: 'gemini-2.0-flash-lite',
    // Gemini 1.5 series (stable)
    GEMINI_15_PRO: 'gemini-1.5-pro',
    GEMINI_15_FLASH: 'gemini-1.5-flash',
  },
  HuggingFace: {
    META_LLAMA_70B: 'meta-llama/Llama-3.3-70B-Instruct',
    META_LLAMA_8B:  'meta-llama/Meta-Llama-3.1-8B-Instruct',
    MISTRAL_NEMO:   'mistralai/Mistral-Nemo-Instruct-2407',
    QWEN_72B:       'Qwen/Qwen2.5-72B-Instruct',
    PHI_4:          'microsoft/phi-4',
}
} as const;

