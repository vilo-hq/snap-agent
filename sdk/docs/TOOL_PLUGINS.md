# Tool Plugins — Internal Reference

## Overview

Tool plugins give agents executable capabilities (API calls, computations, DB queries).
When tool plugins are attached to an agent, the SDK automatically:

1. Collects tools from all `ToolPlugin` instances via `getTools()`
2. Converts them to the AI SDK's `ToolSet` format using `convertToolPlugins()`
3. Passes the `ToolSet` to `generateText()` / `streamText()`
4. Enables multi-step execution so the model can call tools, receive results, and continue reasoning

## Architecture

```
ToolPlugin.getTools()          SnapAgent Tool interface
        │                      { name, description, parameters (JSON Schema), execute }
        ▼
convertToolPlugins()           sdk/src/core/toolUtils.ts
        │                      Wraps each tool with AI SDK's tool() + jsonSchema()
        ▼
AI SDK ToolSet                 Record<string, AISdkTool>
        │                      Keyed by tool name
        ▼
generateText({ tools })        Vercel AI SDK handles the LLM ↔ tool loop
```

## Key Files

| File | Role |
|------|------|
| `src/core/toolUtils.ts` | `convertTool()` and `convertToolPlugins()` — reusable conversion functions |
| `src/core/PluginManager.ts` | `getAISDKTools()` — returns the converted ToolSet or `undefined` |
| `src/core/Agent.ts` | Passes tools + `maxSteps` into `generateText()` and `streamText()` |
| `src/types/plugins.ts` | `Tool` and `ToolPlugin` interface definitions |

## Conversion Details

Our `Tool` interface uses a plain JSON Schema object for `parameters`:

```ts
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;  // JSON Schema
  execute: (args: any) => Promise<any>;
}
```

The AI SDK's `tool()` helper expects a `Schema` (Zod schema or `jsonSchema()` wrapper).
The conversion wraps our plain object with `jsonSchema()`:

```ts
import { tool as aiTool, jsonSchema } from 'ai';

function convertTool(snapTool: Tool) {
  return aiTool({
    description: snapTool.description,
    parameters: jsonSchema(snapTool.parameters),
    execute: snapTool.execute,
  });
}
```

The `convertToolPlugins()` function iterates all plugins, flattens their tools, and
builds the `Record<string, AISdkTool>` keyed by `tool.name`.

## Multi-Step Execution

When tools are present, `stopWhen: stepCountIs(n)` is set (default n=5) so the model can:

1. Receive the user message
2. Decide to call one or more tools
3. Receive tool results
4. Decide to call more tools or produce a final text answer

This is controlled by the `maxToolSteps` option on `generateResponse()` / `streamResponse()`,
which maps to the AI SDK's `stopWhen: stepCountIs(maxToolSteps)`.
When no tool plugins are registered, `stopWhen` is omitted entirely (the AI SDK defaults
to `stepCountIs(1)`, meaning no tool loop overhead).

## Writing a Tool Plugin

```ts
import type { ToolPlugin, Tool } from '@snap-agent/core';

class MyToolPlugin implements ToolPlugin {
  name = 'my-tools';
  type = 'tool' as const;
  priority = 100;

  getTools(): Tool[] {
    return [
      {
        name: 'my_action',
        description: 'Does something useful',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'The input value' },
          },
          required: ['input'],
        },
        execute: async (args: { input: string }) => {
          return { result: `Processed: ${args.input}` };
        },
      },
    ];
  }
}
```

### Parameter Schema Rules

- Must be a valid JSON Schema object (type `"object"` at the top level)
- Use `properties` to define each parameter with `type` and `description`
- Use `required` array to mark mandatory parameters
- Supported types: `string`, `number`, `boolean`, `array`, `object`
- Use `enum` for constrained string values
- Use `description` on every property — the LLM reads these to decide how to call the tool

### Execute Return Value

- Return any JSON-serializable value
- The AI SDK stringifies the return value and feeds it back to the model as a tool result
- For errors, return an object with an `error` field rather than throwing

## Plugin Persistence

Tool plugins support `getConfig()` for serialization to the database via the plugin registry.
Implement it when your plugin has configurable options:

```ts
class MyToolPlugin implements ToolPlugin {
  // ...
  private apiKey: string;

  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
  }

  getConfig() {
    return { apiKey: '${MY_API_KEY}' }; // env var reference
  }
}
```

See `sdk/docs/QUICK_REFERENCE_PLUGINS.md` for more on plugin registration and persistence.
