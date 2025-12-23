/**
 * Streaming Example
 * 
 * This example demonstrates real-time streaming of AI responses
 */

import { createClient, MemoryStorage } from '../src';

async function main() {
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  console.log('Setting up agent and thread...\n');

  // Create agent and thread
  const agent = await client.createAgent({
    name: 'Storyteller',
    instructions: 'You are a creative storyteller. Write engaging short stories.',
    model: 'gpt-4o',
    userId: 'user-123',
  });

  const thread = await client.createThread({
    agentId: agent.id,
    userId: 'user-123',
  });

  console.log('Asking for a story (streaming)...\n');
  console.log('─'.repeat(60));

  // Stream a response
  await client.chatStream(
    {
      threadId: thread.id,
      message: 'Tell me a short story about a robot learning to paint. Keep it to 3 paragraphs.',
    },
    {
      onChunk: (chunk) => {
        // Write each chunk as it arrives
        process.stdout.write(chunk);
      },
      onComplete: (fullResponse) => {
        console.log('\n' + '─'.repeat(60));
        console.log(`\nStreaming complete! (${fullResponse.length} characters)\n`);
        
        // You can do something with the full response here
        console.log('Response saved to thread');
      },
      onError: (error) => {
        console.error('\nError:', error.message);
      },
    }
  );

  // Get the conversation history
  const messages = await thread.getMessages();
  console.log(`\nMessages in thread: ${messages.length}`);
  console.log('   User messages:', messages.filter(m => m.role === 'user').length);
  console.log('   Assistant messages:', messages.filter(m => m.role === 'assistant').length);
}

main().catch(console.error);

