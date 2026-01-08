/**
 * Plugin Registry for serializing/deserializing plugins
 *
 * Plugins are runtime objects that can't be stored in a database.
 * This registry enables:
 * 1. Storing serializable plugin configurations in MongoDB
 * 2. Reinstantiating plugins from stored config when loading agents
 */

import type { Plugin, StoredPluginConfig } from '../types/plugins';

// Re-export for convenience
export type { StoredPluginConfig } from '../types/plugins';

/**
 * Factory function that creates a plugin instance from config
 */
export type PluginFactory<T extends Plugin = Plugin> = (
  config: Record<string, any>
) => T | Promise<T>;

/**
 * Plugin registration entry
 */
interface PluginRegistration {
  factory: PluginFactory;
  defaultConfig?: Record<string, any>;
}

// ============================================================================
// Environment Variable Resolution
// ============================================================================

/**
 * Resolves environment variable references in config values
 * Format: "${ENV_VAR_NAME}" or "${ENV_VAR_NAME:default_value}"
 *
 * @example
 * resolveEnvVars({ apiKey: "${OPENAI_API_KEY}" })
 * // Returns: { apiKey: "sk-..." } (actual env value)
 *
 * @example
 * resolveEnvVars({ timeout: "${TIMEOUT:5000}" })
 * // Returns: { timeout: "5000" } (default if env not set)
 */
export function resolveEnvVars(config: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      // Check for env var pattern: ${VAR_NAME} or ${VAR_NAME:default}
      const envMatch = value.match(/^\$\{([^}:]+)(?::([^}]*))?\}$/);
      if (envMatch) {
        const [, envVar, defaultValue] = envMatch;
        const envValue = process.env[envVar];
        if (envValue !== undefined) {
          resolved[key] = envValue;
        } else if (defaultValue !== undefined) {
          resolved[key] = defaultValue;
        } else {
          throw new Error(
            `Environment variable ${envVar} is required for plugin config but not set`
          );
        }
      } else {
        resolved[key] = value;
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively resolve nested objects
      resolved[key] = resolveEnvVars(value);
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

// ============================================================================
// Plugin Registry
// ============================================================================

/**
 * Global plugin registry for managing plugin factories
 *
 * @example
 * // Register a plugin factory
 * pluginRegistry.register('@snap-agent/rag-ecommerce', (config) =>
 *   new EcommerceRAGPlugin(config)
 * );
 *
 * // Later, instantiate from stored config
 * const plugin = await pluginRegistry.instantiate({
 *   type: 'rag',
 *   name: '@snap-agent/rag-ecommerce',
 *   config: { mongoUri: '${MONGO_URI}', voyageApiKey: '${VOYAGE_API_KEY}' }
 * });
 */
export class PluginRegistry {
  private registrations = new Map<string, PluginRegistration>();

  /**
   * Register a plugin factory
   *
   * @param name - Unique plugin identifier (e.g., "@snap-agent/rag-ecommerce")
   * @param factory - Function that creates plugin instance from config
   * @param defaultConfig - Optional default configuration values
   */
  register(
    name: string,
    factory: PluginFactory,
    defaultConfig?: Record<string, any>
  ): void {
    if (this.registrations.has(name)) {
      console.warn(`Plugin "${name}" is already registered. Overwriting.`);
    }
    this.registrations.set(name, { factory, defaultConfig });
  }

  /**
   * Unregister a plugin factory
   */
  unregister(name: string): boolean {
    return this.registrations.delete(name);
  }

  /**
   * Check if a plugin is registered
   */
  isRegistered(name: string): boolean {
    return this.registrations.has(name);
  }

  /**
   * Get all registered plugin names
   */
  getRegisteredPlugins(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Instantiate a plugin from stored configuration
   *
   * @param storedConfig - Serialized plugin configuration from database
   * @returns Plugin instance
   * @throws Error if plugin is not registered
   */
  async instantiate(storedConfig: StoredPluginConfig): Promise<Plugin> {
    const registration = this.registrations.get(storedConfig.name);

    if (!registration) {
      throw new Error(
        `Plugin "${storedConfig.name}" is not registered. ` +
          `Available plugins: ${this.getRegisteredPlugins().join(', ') || 'none'}. ` +
          `Make sure to register the plugin before loading the agent.`
      );
    }

    // Merge default config with stored config
    const mergedConfig = {
      ...registration.defaultConfig,
      ...storedConfig.config,
    };

    // Resolve environment variables
    const resolvedConfig = resolveEnvVars(mergedConfig);

    // Create plugin instance
    const plugin = await registration.factory(resolvedConfig);

    // Override priority if specified in stored config
    if (storedConfig.priority !== undefined) {
      (plugin as any).priority = storedConfig.priority;
    }

    return plugin;
  }

  /**
   * Instantiate multiple plugins from stored configurations
   *
   * @param storedConfigs - Array of serialized plugin configurations
   * @returns Array of plugin instances (skips disabled plugins)
   */
  async instantiateAll(storedConfigs: StoredPluginConfig[]): Promise<Plugin[]> {
    const plugins: Plugin[] = [];

    for (const config of storedConfigs) {
      // Skip disabled plugins
      if (config.enabled === false) {
        continue;
      }

      try {
        const plugin = await this.instantiate(config);
        plugins.push(plugin);
      } catch (error) {
        console.error(`Failed to instantiate plugin "${config.name}":`, error);
        throw error;
      }
    }

    return plugins;
  }

  /**
   * Extract serializable configuration from a plugin instance
   * Requires the plugin to implement getConfig() method
   *
   * @param plugin - Plugin instance
   * @returns Stored plugin configuration
   */
  extractConfig(plugin: Plugin & { getConfig?: () => Record<string, any> }): StoredPluginConfig {
    const config = plugin.getConfig?.() ?? {};

    return {
      type: plugin.type,
      name: plugin.name,
      config,
      priority: plugin.priority,
      enabled: true,
    };
  }

  /**
   * Extract configurations from multiple plugins
   */
  extractAllConfigs(
    plugins: Array<Plugin & { getConfig?: () => Record<string, any> }>
  ): StoredPluginConfig[] {
    return plugins.map((plugin) => this.extractConfig(plugin));
  }
}

// ============================================================================
// Default Global Registry
// ============================================================================

/**
 * Default global plugin registry instance
 * Use this for simple setups, or create your own PluginRegistry for isolation
 */
export const pluginRegistry = new PluginRegistry();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an env var reference for use in stored plugin configs
 *
 * @example
 * const config = {
 *   apiKey: envRef('OPENAI_API_KEY'),
 *   timeout: envRef('TIMEOUT', '5000'),
 * };
 */
export function envRef(envVarName: string, defaultValue?: string): string {
  if (defaultValue !== undefined) {
    return `\${${envVarName}:${defaultValue}}`;
  }
  return `\${${envVarName}}`;
}

