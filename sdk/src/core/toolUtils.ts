import { jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { Tool, ToolPlugin } from '../types/plugins';

/**
 * Convert a single SnapAgent Tool definition into an AI SDK tool object.
 *
 * The AI SDK expects `inputSchema` to be a Schema (Zod or jsonSchema wrapper).
 * Our Tool interface uses a plain JSON Schema object for `parameters`, so we
 * wrap it with `jsonSchema()` and map it to `inputSchema`.
 */
export function convertTool(snapTool: Tool) {
  return {
    description: snapTool.description,
    inputSchema: jsonSchema<any>(snapTool.parameters),
    execute: snapTool.execute,
  };
}

/**
 * Convert an array of ToolPlugin instances into an AI SDK ToolSet.
 *
 * The ToolSet is a `Record<string, Tool>` keyed by tool name, which is the
 * format that `generateText()` and `streamText()` expect.
 *
 * @example
 * ```ts
 * const plugins: ToolPlugin[] = [weatherPlugin, calculatorPlugin];
 * const tools = convertToolPlugins(plugins);
 * // tools = { get_weather: AISdkTool, calculate: AISdkTool }
 *
 * const result = await generateText({ model, messages, tools });
 * ```
 */
export function convertToolPlugins(plugins: ToolPlugin[]): ToolSet {
  const toolSet: ToolSet = {};

  for (const plugin of plugins) {
    for (const snapTool of plugin.getTools()) {
      toolSet[snapTool.name] = convertTool(snapTool);
    }
  }

  return toolSet;
}
