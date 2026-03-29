/**
 * Tool Plugin Example
 *
 * Demonstrates how to create a tool plugin that gives an agent
 * executable capabilities. The agent can call these tools during
 * a conversation to fetch real data, perform calculations, or
 * trigger side-effects — then incorporate the results into its answer.
 */

import { createClient, MemoryStorage } from '../src';
import type { ToolPlugin, Tool } from '../src';

// ---------------------------------------------------------------------------
// 1. Define a tool plugin
// ---------------------------------------------------------------------------

/**
 * A weather tool plugin that exposes a `get_weather` tool.
 * In production this would call a real weather API.
 */
class WeatherToolPlugin implements ToolPlugin {
  name = 'weather-tools';
  type = 'tool' as const;
  priority = 100;

  getTools(): Tool[] {
    return [
      {
        name: 'get_weather',
        description: 'Get the current weather for a given city',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name, e.g. "San Francisco"',
            },
            units: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature units (default: celsius)',
            },
          },
          required: ['city'],
        },
        execute: async (args: { city: string; units?: string }) => {
          // Simulate an API call
          const temp = Math.round(15 + Math.random() * 20);
          const unit = args.units === 'fahrenheit' ? 'F' : 'C';
          return {
            city: args.city,
            temperature: unit === 'F' ? Math.round(temp * 9 / 5 + 32) : temp,
            unit,
            condition: 'partly cloudy',
          };
        },
      },
    ];
  }
}

/**
 * A calculator tool plugin with basic math operations.
 */
class CalculatorToolPlugin implements ToolPlugin {
  name = 'calculator-tools';
  type = 'tool' as const;
  priority = 100;

  getTools(): Tool[] {
    return [
      {
        name: 'calculate',
        description: 'Evaluate a mathematical expression and return the numeric result',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'A mathematical expression, e.g. "2 + 2" or "sqrt(144)"',
            },
          },
          required: ['expression'],
        },
        execute: async (args: { expression: string }) => {
          // Simple and safe evaluation for demo purposes
          const sanitized = args.expression.replace(/[^0-9+\-*/().%\s]/g, '');
          try {
            // eslint-disable-next-line no-eval
            const result = Function(`"use strict"; return (${sanitized})`)();
            return { expression: args.expression, result };
          } catch {
            return { expression: args.expression, error: 'Invalid expression' };
          }
        },
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// 2. Use them with an agent
// ---------------------------------------------------------------------------

async function main() {
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  // Create an agent with both tool plugins attached
  const agent = await client.createAgent({
    name: 'Tool-Equipped Assistant',
    instructions:
      'You are a helpful assistant. Use the available tools to answer questions ' +
      'that require real-time data or computation. Always prefer calling a tool ' +
      'over guessing.',
    model: 'gpt-4o',
    userId: 'user-123',
    plugins: [new WeatherToolPlugin(), new CalculatorToolPlugin()],
  });

  console.log(`Agent created: ${agent.name} (${agent.id})`);
  console.log(`Plugins: ${agent.plugins.map(p => p.name).join(', ')}\n`);

  // Create a thread and ask a question that requires tool use
  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'user-123',
  });

  console.log('User: What is the weather in Tokyo and how much is 18 * 47?\n');

  const response = await client.chat({
    threadId: thread.id,
    message: 'What is the weather in Tokyo and how much is 18 * 47?',
  });

  console.log('Agent:', response.reply, '\n');

  // Streaming also works with tools — the model resolves tool calls internally
  // and then streams the final text answer.
  console.log('--- Streaming example ---\n');
  console.log('User: What is the weather in Berlin in fahrenheit?\n');
  console.log('Agent: ');

  await client.chatStream(
    {
      threadId: thread.id,
      message: 'What is the weather in Berlin in fahrenheit?',
    },
    {
      onChunk: (chunk) => process.stdout.write(chunk),
      onComplete: () => console.log('\n'),
      onError: (err) => console.error('Error:', err.message),
    },
  );
}

main().catch(console.error);
