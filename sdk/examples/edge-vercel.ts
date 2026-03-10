/**
 * Example: Vercel Edge Function with SnapAgent SDK
 *
 * This example shows how to deploy an AI agent to Vercel Edge Functions
 * using the Next.js App Router.
 *
 * Setup:
 * 1. Create a Next.js project: npx create-next-app@latest my-agent-app
 * 2. cd my-agent-app
 * 3. npm install @snap-agent/core ai @ai-sdk/openai
 * 4. Add OPENAI_API_KEY to Vercel environment variables (or .env.local for dev)
 * 5. Copy this file to: app/api/chat/route.ts
 */

import { createClient, MemoryStorage, Models, Agent } from '@snap-agent/core';

// Mark the route as an Edge Function
export const runtime = 'edge';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// In-memory agent cache (persists across requests within the same isolate)
const agentCache = new Map<string, Agent>();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function getOrCreateAgent(
  client: ReturnType<typeof createClient>,
  userId: string,
  instructions: string
): Promise<Agent> {
  let agent = agentCache.get(userId);
  if (!agent) {
    agent = await client.createAgent({
      name: 'Vercel Edge Agent',
      instructions,
      provider: 'openai',
      model: Models.OpenAI.GPT4O_MINI,
      userId,
    });
    agentCache.set(userId, agent);
  }
  return agent;
}

// Handle CORS preflight
export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      message: string;
      userId?: string;
      systemPrompt?: string;
      stream?: boolean;
    };

    if (!body.message) {
      return jsonResponse({ error: 'Message is required' }, 400);
    }

    const client = createClient({
      storage: new MemoryStorage(),
      providers: {
        openai: { apiKey: process.env.OPENAI_API_KEY! },
      },
    });

    const userId = body.userId || 'vercel-user';
    const instructions =
      body.systemPrompt ||
      `You are a helpful assistant deployed on Vercel Edge.
Respond concisely and be helpful.
Current time: ${new Date().toISOString()}`;

    const agent = await getOrCreateAgent(client, userId, instructions);
    const messages: ChatMessage[] = [{ role: 'user', content: body.message }];

    // Streaming response via Server-Sent Events
    if (body.stream) {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          await agent.streamResponse(
            messages,
            (chunk: string) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
            },
            (fullResponse: string, metadata?: Record<string, unknown>) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ done: true, fullResponse, metadata })}\n\n`
                )
              );
              controller.close();
            },
            (error: Error) => {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`)
              );
              controller.close();
            }
          );
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Non-streaming response
    const startTime = Date.now();
    const result = await agent.generateResponse(messages);
    const latency = Date.now() - startTime;

    return jsonResponse({
      reply: result.text,
      meta: {
        latency: `${latency}ms`,
        model: Models.OpenAI.GPT4O_MINI,
        runtime: 'vercel-edge',
        region: process.env.VERCEL_REGION || 'unknown',
      },
    });
  } catch (error) {
    console.error('Edge function error:', error);
    return jsonResponse(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

/**
 * Usage examples:
 *
 * Non-streaming:
 * curl -X POST https://your-app.vercel.app/api/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{"message": "What is the capital of France?"}'
 *
 * Streaming:
 * curl -X POST https://your-app.vercel.app/api/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{"message": "Write a haiku about coding", "stream": true}'
 *
 * JavaScript client (streaming):
 * const response = await fetch('/api/chat', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ message: 'Hello!', stream: true }),
 * });
 *
 * const reader = response.body.getReader();
 * const decoder = new TextDecoder();
 * while (true) {
 *   const { done, value } = await reader.read();
 *   if (done) break;
 *   const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
 *   for (const line of lines) {
 *     const data = JSON.parse(line.slice(6));
 *     if (data.chunk) process.stdout.write(data.chunk);
 *     if (data.done) console.log('\n--- Complete ---');
 *   }
 * }
 */
