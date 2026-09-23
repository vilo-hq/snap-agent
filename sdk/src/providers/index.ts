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
 * Model ids for quick reference — the catalog that `GET /models` in the AgentSnap server and its UI
 * are built from. Every id is passed to the provider as-is by `ProviderFactory.getModel` (there is
 * no validation), so anything the provider serves works even if it is not listed here; this list is
 * what customers get to pick from.
 *
 * Only models the providers currently serve. Retired ids are removed rather than kept as aliases:
 * a retired model in the catalog is an agent that stops answering.
 *
 * Sources, checked September 2026:
 *   OpenAI    developers.openai.com/api/docs/models + /pricing
 *   Anthropic Claude API models list (aliases without date suffixes, as Anthropic recommends)
 *   Google    ai.google.dev/gemini-api/docs/models (1.5 and 2.0 families are shut down; 2.5 is
 *             restricted to existing users, so it is not offered to new agents)
 *
 * Display names live in `ModelDisplayNames` next to this object; do not derive them from the keys.
 */
export const Models = {
  OpenAI: {
    // GPT-6 (flagship family)
    GPT6_ASTRA: 'gpt-6-astra',
    GPT6_SOL: 'gpt-6-sol',
    GPT6_LUNA: 'gpt-6-luna',
    // GPT-5.6
    GPT5_6_SOL: 'gpt-5.6-sol',
    GPT5_6_TERRA: 'gpt-5.6-terra',
    GPT5_6_LUNA: 'gpt-5.6-luna',
    // GPT-5.5
    GPT5_5: 'gpt-5.5',
    GPT5_5_PRO: 'gpt-5.5-pro',
    // GPT-5.4
    GPT5_4: 'gpt-5.4',
    GPT5_4_MINI: 'gpt-5.4-mini',
    GPT5_4_NANO: 'gpt-5.4-nano',
    GPT5_4_PRO: 'gpt-5.4-pro',
    // GPT-5.2 / 5.1 / 5
    GPT5_2: 'gpt-5.2',
    GPT5_2_PRO: 'gpt-5.2-pro',
    GPT5_1: 'gpt-5.1',
    GPT5: 'gpt-5',
    GPT5_MINI: 'gpt-5-mini',
    GPT5_NANO: 'gpt-5-nano',
    GPT5_PRO: 'gpt-5-pro',
    // GPT-4.1
    GPT4_1: 'gpt-4.1',
    GPT4_1_MINI: 'gpt-4.1-mini',
    GPT4_1_NANO: 'gpt-4.1-nano',
    // GPT-4o
    GPT4O: 'gpt-4o',
    GPT4O_MINI: 'gpt-4o-mini',
    // Reasoning (o-series)
    O3: 'o3',
    O3_PRO: 'o3-pro',
    O3_MINI: 'o3-mini',
    O4_MINI: 'o4-mini',
    O1: 'o1',
    O1_PRO: 'o1-pro',
  },
  Anthropic: {
    // Claude 5 generation
    CLAUDE_FABLE_5_1: 'claude-fable-5-1',
    CLAUDE_FABLE_5: 'claude-fable-5',
    CLAUDE_OPUS_5: 'claude-opus-5',
    CLAUDE_SONNET_5: 'claude-sonnet-5',
    // Claude 4.x still served
    CLAUDE_OPUS_4_8: 'claude-opus-4-8',
    CLAUDE_OPUS_4_7: 'claude-opus-4-7',
    CLAUDE_OPUS_4_6: 'claude-opus-4-6',
    CLAUDE_OPUS_4_5: 'claude-opus-4-5',
    CLAUDE_SONNET_4_6: 'claude-sonnet-4-6',
    CLAUDE_SONNET_4_5: 'claude-sonnet-4-5',
    CLAUDE_HAIKU_4_5: 'claude-haiku-4-5',
  },
  Google: {
    // Gemini 3.x stable
    GEMINI_3_8_FLASH: 'gemini-3.8-flash',
    GEMINI_3_7_FLASH: 'gemini-3.7-flash',
    GEMINI_3_6_FLASH: 'gemini-3.6-flash',
    GEMINI_3_5_FLASH: 'gemini-3.5-flash',
    GEMINI_3_5_FLASH_LITE: 'gemini-3.5-flash-lite',
    GEMINI_3_1_FLASH_LITE: 'gemini-3.1-flash-lite',
    // Gemini 3.x preview
    GEMINI_3_1_PRO_PREVIEW: 'gemini-3.1-pro-preview',
    GEMINI_3_FLASH_PREVIEW: 'gemini-3-flash-preview',
  },
  HuggingFace: {
    META_LLAMA_70B: 'meta-llama/Llama-3.3-70B-Instruct',
    META_LLAMA_8B:  'meta-llama/Meta-Llama-3.1-8B-Instruct',
    MISTRAL_NEMO:   'mistralai/Mistral-Nemo-Instruct-2407',
    QWEN_72B:       'Qwen/Qwen2.5-72B-Instruct',
    PHI_4:          'microsoft/phi-4',
  },
} as const;

/** Human-readable names by model id, for pickers and catalogs. Keyed by id, not by constant name. */
export const ModelDisplayNames: Record<string, string> = {
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.5-pro': 'GPT-5.5 Pro',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.4-pro': 'GPT-5.4 Pro',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-pro': 'GPT-5.2 Pro',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5-nano': 'GPT-5 Nano',
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'o3': 'o3',
  'o3-pro': 'o3 Pro',
  'o3-mini': 'o3 Mini',
  'o4-mini': 'o4 Mini',
  'o1': 'o1',
  'o1-pro': 'o1 Pro',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-fable-5': 'Claude Fable 5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (preview)',
  'gemini-3-flash-preview': 'Gemini 3 Flash (preview)',
  'meta-llama/Llama-3.3-70B-Instruct': 'Llama 3.3 70B Instruct',
  'meta-llama/Meta-Llama-3.1-8B-Instruct': 'Llama 3.1 8B Instruct',
  'mistralai/Mistral-Nemo-Instruct-2407': 'Mistral Nemo Instruct',
  'Qwen/Qwen2.5-72B-Instruct': 'Qwen 2.5 72B Instruct',
  'microsoft/phi-4': 'Phi-4',
};

/** Display name for a model id; falls back to the id itself for models not in the catalog. */
export function displayNameForModel(modelId: string): string {
  return ModelDisplayNames[modelId] ?? modelId;
}

