/**
 * Basic Usage Example
 * 
 * This example demonstrates the core functionality:
 * - Creating an agent
 * - Creating a thread
 * - Having a conversation
 */

import { createClient, MemoryStorage } from '../src';

async function main() {
  // Initialize the SDK with in-memory storage (for demo purposes)
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  console.log('Creating agent...');

  // Create an agent
  const agent = await client.createAgent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant that provides clear and concise answers.',
    model: 'gpt-4o',
    userId: 'user-123',
  });

  console.log(`Agent created: ${agent.id}`);
  console.log(`  Name: ${agent.name}`);
  console.log(`  Model: ${agent.model}\n`);

  // Create a conversation thread
  console.log('Creating thread...');

  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'user-123',
    name: 'My First Conversation',
  });

  console.log(`Thread created: ${thread.id}\n`);

  // Have a conversation
  console.log('Sending message...\n');

  const response1 = await client.chat({
    threadId: thread.id,
    message: 'What is TypeScript?',
  });

  console.log('Agent:', response1.reply, '\n');

  // Continue the conversation
  console.log('Sending follow-up...\n');

  const response2 = await client.chat({
    threadId: thread.id,
    message: 'Can you give me a simple example?',
  });

  console.log('Agent:', response2.reply, '\n');

  // Get conversation history
  const messages = await thread.getMessages();
  console.log(`Total messages in thread: ${messages.length}`);

  // List all threads
  const allThreads = await client.listThreads({ userId: 'user-123' });
  console.log(`Total threads for user: ${allThreads.length}`);
}

main().catch(console.error);

