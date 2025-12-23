/**
 * Example: Vercel Edge Function with SnapAgent SDK
 * 
 * This example shows how to deploy an AI agent to Vercel Edge Functions.
 * 
 * Setup:
 * 1. Create a Next.js or standalone Vercel project
 * 2. npm install @snap-agent/core ai @ai-sdk/openai
 * 3. Add OPENAI_API_KEY to Vercel environment variables
 * 4. Create this file at: app/api/chat/route.ts (App Router)
 *    or: pages/api/chat.ts (Pages Router)
 */

import { createClient, MemoryStorage, Models } from '@snap-agent/core/edge';

// Enable edge runtime
export const config = {
  runtime: 'edge',
};

// Simple agent cache (persists across requests in the same isolate)
const agentCache = new Map<string, any>();

export default async function handler(request: Request) {
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

  // Only allow POST
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json() as { 
      message: string; 
      userId?: string;
      stream?: boolean;
    };

    if (!body.message) {
      return new Response(
        JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize client
    const client = createClient({
      storage: new MemoryStorage(),
      providers: {
        openai: { apiKey: process.env.OPENAI_API_KEY! },
      },
    });

    const userId = body.userId || 'vercel-user';

    // Get or create agent
    let agent = agentCache.get(userId);
    if (!agent) {
      agent = await client.createAgent({
        name: 'Vercel Edge Agent',
        instructions: `You are a helpful assistant deployed on Vercel Edge.
Respond concisely and be helpful.
Current time: ${new Date().toISOString()}`,
        provider: 'openai',
        model: Models.OpenAI.GPT4O_MINI,
        userId,
      });
      agentCache.set(userId, agent);
    }

    // Streaming response
    if (body.stream) {
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
        },
      });
    }

    // Non-streaming response
    const startTime = Date.now();
    const { reply } = await agent.chat(body.message);
    const latency = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        reply,
        meta: {
          latency: `${latency}ms`,
          model: Models.OpenAI.GPT4O_MINI,
          runtime: 'vercel-edge',
          region: process.env.VERCEL_REGION || 'unknown',
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Alternative: Next.js App Router format
 * 
 * // app/api/chat/route.ts
 * import { NextRequest } from 'next/server';
 * 
 * export const runtime = 'edge';
 * 
 * export async function POST(request: NextRequest) {
 *   // Same implementation as above
 * }
 */

