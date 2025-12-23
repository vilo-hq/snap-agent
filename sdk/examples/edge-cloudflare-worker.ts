/**
 * Example: Cloudflare Worker with SnapAgent SDK
 * 
 * This example shows how to deploy an AI agent to Cloudflare Workers.
 * 
 * Setup:
 * 1. npm create cloudflare@latest my-agent-worker
 * 2. cd my-agent-worker
 * 3. npm install @snap-agent/core ai @ai-sdk/openai
 * 4. wrangler secret put OPENAI_API_KEY
 * 5. Replace src/index.ts with this file
 * 6. wrangler deploy
 */

import { createClient, MemoryStorage, Models } from '@snap-agent/core';

export interface Env {
  OPENAI_API_KEY: string;
}

// Simple in-memory cache for agents (optional optimization)
const agentCache = new Map<string, any>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Parse URL
    const url = new URL(request.url);

    try {
      // Initialize SnapAgent client
      const client = createClient({
        storage: new MemoryStorage(),
        providers: {
          openai: { apiKey: env.OPENAI_API_KEY },
        },
      });

      // Route: POST /chat
      if (url.pathname === '/chat' && request.method === 'POST') {
        const body = await request.json() as { message: string; userId?: string };
        
        if (!body.message) {
          return new Response(
            JSON.stringify({ error: 'Message is required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const userId = body.userId || 'anonymous';
        
        // Get or create agent for this user
        let agent = agentCache.get(userId);
        if (!agent) {
          agent = await client.createAgent({
            name: 'Edge Assistant',
            instructions: `You are a helpful assistant running on Cloudflare's edge network.
You respond concisely and helpfully.
Current time: ${new Date().toISOString()}`,
            provider: 'openai',
            model: Models.OpenAI.GPT4O_MINI,
            userId,
          });
          agentCache.set(userId, agent);
        }

        const startTime = Date.now();
        const { reply } = await agent.chat(body.message);
        const latency = Date.now() - startTime;

        return new Response(
          JSON.stringify({
            reply,
            meta: {
              latency: `${latency}ms`,
              model: Models.OpenAI.GPT4O_MINI,
              runtime: 'cloudflare-workers',
            },
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Route: POST /chat/stream
      if (url.pathname === '/chat/stream' && request.method === 'POST') {
        const body = await request.json() as { message: string; userId?: string };
        
        if (!body.message) {
          return new Response(
            JSON.stringify({ error: 'Message is required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const userId = body.userId || 'anonymous';
        
        let agent = agentCache.get(userId);
        if (!agent) {
          agent = await client.createAgent({
            name: 'Edge Assistant',
            instructions: 'You are a helpful assistant.',
            provider: 'openai',
            model: Models.OpenAI.GPT4O_MINI,
            userId,
          });
          agentCache.set(userId, agent);
        }

        // Create streaming response
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              await agent.chatStream(body.message, {
                onChunk: (chunk: string) => {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
                },
              });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Route: POST /rag/ingest
      if (url.pathname === '/rag/ingest' && request.method === 'POST') {
        const body = await request.json() as { 
          userId: string;
          documents: Array<{ id: string; content: string; metadata?: Record<string, any> }>;
        };

        if (!body.userId || !body.documents) {
          return new Response(
            JSON.stringify({ error: 'userId and documents are required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Create agent with RAG enabled
        const agent = await client.createAgent({
          name: 'RAG Agent',
          instructions: 'Answer questions using the provided context.',
          provider: 'openai',
          model: Models.OpenAI.GPT4O_MINI,
          userId: body.userId,
          rag: { enabled: true },
        });
        agentCache.set(body.userId, agent);

        const result = await agent.ingestDocuments(body.documents);

        return new Response(
          JSON.stringify(result),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Route: GET /health
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            runtime: 'cloudflare-workers',
            sdk: '@snap-agent/core',
            timestamp: new Date().toISOString(),
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // 404 for unknown routes
      return new Response(
        JSON.stringify({ error: 'Not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (error) {
      console.error('Error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },
};

