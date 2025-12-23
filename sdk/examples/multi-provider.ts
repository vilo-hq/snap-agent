/**
 * Multi-Provider Example
 * 
 * This example demonstrates how to use multiple AI providers:
 * - OpenAI (GPT)
 * - Anthropic (Claude)
 * - Google (Gemini)
 */

import { createClient, MemoryStorage, Models } from '../src';

async function main() {
  // Initialize SDK with multiple providers
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
      google: { apiKey: process.env.GOOGLE_API_KEY! },
    },
  });

  console.log('Creating agents with different providers...\n');

  // Create GPT agent
  const gptAgent = await client.createAgent({
    name: 'GPT Assistant',
    provider: 'openai',
    model: Models.OpenAI.GPT4O,
    instructions: 'You are GPT-4. Respond with "I am GPT-4" in your answer.',
    userId: 'user-123',
  });
  console.log(`Created GPT agent: ${gptAgent.id}`);

  // Create Claude agent
  const claudeAgent = await client.createAgent({
    name: 'Claude Assistant',
    provider: 'anthropic',
    model: Models.Anthropic.CLAUDE_35_SONNET,
    instructions: 'You are Claude. Respond with "I am Claude" in your answer.',
    userId: 'user-123',
  });
  console.log(`Created Claude agent: ${claudeAgent.id}`);

  // Create Gemini agent
  const geminiAgent = await client.createAgent({
    name: 'Gemini Assistant',
    provider: 'google',
    model: Models.Google.GEMINI_2_FLASH,
    instructions: 'You are Gemini. Respond with "I am Gemini" in your answer.',
    userId: 'user-123',
  });
  console.log(`Created Gemini agent: ${geminiAgent.id}\n`);

  const question = 'What is your name and what can you do?';
  
  // Chat with GPT
  console.log('[GPT] Asking GPT...');
  const gptThread = await client.createThread({
    agentId: gptAgent.id,
    userId: 'user-123',
  });
  const gptResponse = await client.chat({
    threadId: gptThread.id,
    message: question,
  });
  console.log(`GPT: ${gptResponse.reply.substring(0, 150)}...\n`);

  // Chat with Claude
  console.log('[Claude] Asking Claude...');
  const claudeThread = await client.createThread({
    agentId: claudeAgent.id,
    userId: 'user-123',
  });
  const claudeResponse = await client.chat({
    threadId: claudeThread.id,
    message: question,
  });
  console.log(`Claude: ${claudeResponse.reply.substring(0, 150)}...\n`);

  // Chat with Gemini
  console.log('[Gemini] Asking Gemini...');
  const geminiThread = await client.createThread({
    agentId: geminiAgent.id,
    userId: 'user-123',
  });
  const geminiResponse = await client.chat({
    threadId: geminiThread.id,
    message: question,
  });
  console.log(`Gemini: ${geminiResponse.reply.substring(0, 150)}...\n`);

  // Show configured providers
  console.log('Configured providers:', client.getConfiguredProviders());
}

main().catch(console.error);

