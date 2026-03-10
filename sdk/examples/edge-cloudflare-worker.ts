/**
 * Example: Cloudflare Worker with SnapAgent SDK
 *
 * This example shows how to deploy an AI agent to Cloudflare Workers.
 * The worker provides stateless chat endpoints with optional RAG support.
 *
 * See: sdk/examples/CLOUDFLARE_DEPLOY.md for deployment instructions.
 *
 * Setup:
 * 1. npm create cloudflare@latest my-agent-worker
 * 2. cd my-agent-worker
 * 3. npm install @snap-agent/core ai @ai-sdk/openai
 * 4. npx wrangler secret put OPENAI_API_KEY
 * 5. Replace src/index.ts with this file
 * 6. npx wrangler deploy
 */

import { createClient, MemoryStorage, Models, Agent } from '@snap-agent/core';

export interface Env {
  OPENAI_API_KEY: string;
}

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
      name: 'Edge Assistant',
      instructions,
      provider: 'openai',
      model: Models.OpenAI.GPT4O_MINI,
      userId,
    });
    agentCache.set(userId, agent);
  }
  return agent;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      const client = createClient({
        storage: new MemoryStorage(),
        providers: {
          openai: { apiKey: env.OPENAI_API_KEY },
        },
      });

      // Route: POST /chat — single message, full response
      if (url.pathname === '/chat' && request.method === 'POST') {
        const body = (await request.json()) as {
          message: string;
          userId?: string;
          systemPrompt?: string;
        };

        if (!body.message) {
          return jsonResponse({ error: 'Message is required' }, 400);
        }

        const userId = body.userId || 'anonymous';
        const instructions =
          body.systemPrompt ||
          `You are a helpful assistant running on Cloudflare's edge network.
You respond concisely and helpfully.
Current time: ${new Date().toISOString()}`;

        const agent = await getOrCreateAgent(client, userId, instructions);

        const messages: ChatMessage[] = [{ role: 'user', content: body.message }];
        const startTime = Date.now();
        const result = await agent.generateResponse(messages);
        const latency = Date.now() - startTime;

        return jsonResponse({
          reply: result.text,
          meta: {
            latency: `${latency}ms`,
            model: Models.OpenAI.GPT4O_MINI,
            runtime: 'cloudflare-workers',
          },
        });
      }

      // Route: POST /chat/stream — Server-Sent Events streaming
      if (url.pathname === '/chat/stream' && request.method === 'POST') {
        const body = (await request.json()) as {
          message: string;
          userId?: string;
          systemPrompt?: string;
        };

        if (!body.message) {
          return jsonResponse({ error: 'Message is required' }, 400);
        }

        const userId = body.userId || 'anonymous';
        const instructions = body.systemPrompt || 'You are a helpful assistant.';
        const agent = await getOrCreateAgent(client, userId, instructions);

        const encoder = new TextEncoder();
        const messages: ChatMessage[] = [{ role: 'user', content: body.message }];

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

      // Route: POST /rag/ingest — ingest documents into agent's RAG store
      if (url.pathname === '/rag/ingest' && request.method === 'POST') {
        const body = (await request.json()) as {
          userId: string;
          documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
        };

        if (!body.userId || !body.documents?.length) {
          return jsonResponse({ error: 'userId and documents are required' }, 400);
        }

        const agent = await client.createAgent({
          name: 'RAG Agent',
          instructions:
            'Answer questions using the provided context. Be accurate and cite sources when possible.',
          provider: 'openai',
          model: Models.OpenAI.GPT4O_MINI,
          userId: body.userId,
          rag: { enabled: true },
        });
        agentCache.set(body.userId, agent);

        const results = await agent.ingestDocuments(body.documents);
        return jsonResponse({ ingested: results.length, results });
      }

      // Route: POST /rag/query — query with RAG context
      if (url.pathname === '/rag/query' && request.method === 'POST') {
        const body = (await request.json()) as {
          message: string;
          userId?: string;
        };

        if (!body.message) {
          return jsonResponse({ error: 'Message is required' }, 400);
        }

        const userId = body.userId || 'anonymous';
        const agent = await client.createAgent({
          name: 'RAG Agent',
          instructions:
            'Answer questions using the provided context. Be accurate and cite sources when possible.',
          provider: 'openai',
          model: Models.OpenAI.GPT4O_MINI,
          userId,
          rag: { enabled: true },
        });

        const messages: ChatMessage[] = [{ role: 'user', content: body.message }];
        const startTime = Date.now();
        const result = await agent.generateResponse(messages, { useRAG: true });
        const latency = Date.now() - startTime;

        return jsonResponse({
          reply: result.text,
          metadata: result.metadata,
          meta: {
            latency: `${latency}ms`,
            model: Models.OpenAI.GPT4O_MINI,
            runtime: 'cloudflare-workers',
          },
        });
      }

      // Route: GET /health
      if (url.pathname === '/health') {
        return jsonResponse({
          status: 'ok',
          runtime: 'cloudflare-workers',
          sdk: '@snap-agent/core',
          timestamp: new Date().toISOString(),
        });
      }

      return jsonResponse(
        {
          error: 'Not found',
          availableRoutes: ['/chat', '/chat/stream', '/rag/ingest', '/rag/query', '/health'],
        },
        404
      );
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse(
        {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        500
      );
    }
  },
};
