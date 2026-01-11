/**
 * Structured Output Example
 *
 * Demonstrates how to get structured JSON responses from agents using:
 * - Flexible JSON mode: For arbitrary JSON structures (mode: 'json')
 * - Object mode with schemas: For typed, validated responses (mode: 'object')
 *
 * Prerequisites:
 * 1. Copy .env.example to .env
 * 2. Add your OPENAI_API_KEY to .env
 *
 * Run: npx tsx examples/json-output.ts
 */

import 'dotenv/config';
import { z } from 'zod';
import { jsonSchema } from 'ai';
import { createClient, MemoryStorage } from '../src';

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS
// Define the exact structure you expect from the AI response
// ═══════════════════════════════════════════════════════════════════════════

// Example 1: Task extraction schema
const TaskSchema = z.object({
  title: z.string().describe('Short task title'),
  priority: z.enum(['low', 'medium', 'high']).describe('Task priority level'),
  dueDate: z.string().optional().describe('Due date if mentioned (ISO format)'),
  assignee: z.string().optional().describe('Person assigned if mentioned'),
});

const TaskListSchema = z.object({
  tasks: z.array(TaskSchema).describe('List of extracted tasks'),
  summary: z.string().describe('Brief summary of the tasks'),
  totalCount: z.number().describe('Total number of tasks extracted'),
});

type TaskList = z.infer<typeof TaskListSchema>;

// Example 2: Sentiment analysis schema
const SentimentSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
  confidence: z.number().min(0).max(1).describe('Confidence score 0-1'),
  keywords: z.array(z.string()).describe('Key phrases that influenced the sentiment'),
  summary: z.string().describe('One sentence explanation'),
});

type SentimentAnalysis = z.infer<typeof SentimentSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Create a client with an agent
// ═══════════════════════════════════════════════════════════════════════════

async function createAgentWithClient(name: string, instructions: string) {
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  const agent = await client.createAgent({
    name,
    instructions,
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'demo-user',
  });

  return { client, agent };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 1: Flexible JSON Mode
// Use when you don't have a predefined schema
// ═══════════════════════════════════════════════════════════════════════════

async function flexibleJsonExample() {
  console.log('\n' + '═'.repeat(60));
  console.log('EXAMPLE 1: Flexible JSON Mode');
  console.log('═'.repeat(60));

  const { agent } = await createAgentWithClient(
    'JSON Extractor',
    'You extract structured data from text. Always respond with valid JSON.'
  );

  const userMessage = `
    Please analyze this meeting note and extract key information:
    
    "Team standup tomorrow at 9am. John will demo the new feature.
    Sarah needs to review the PR by Friday. Bug fix is critical priority."
  `;

  console.log('\nInput:', userMessage.trim());
  console.log('\nGenerating response with mode: "json"...\n');

  const result = await agent.generateResponse(
    [{ role: 'user', content: userMessage }],
    {
      output: {
        mode: 'json', // Flexible JSON - no schema validation
      },
    }
  );

  console.log('Raw text response:');
  console.log(result.text);

  console.log('\nParsed JSON (type: unknown):');
  console.log(JSON.stringify(result.parsed, null, 2));

  // With flexible mode, you need to manually validate/cast the result
  const data = result.parsed as Record<string, unknown>;
  console.log('\nAccessing data (requires type assertion):');
  console.log('- Data type:', typeof data);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 2: Structured Object Mode with JSON Schema
// Use when you need type-safe, validated responses
// ═══════════════════════════════════════════════════════════════════════════

async function structuredObjectExample() {
  console.log('\n' + '═'.repeat(60));
  console.log('EXAMPLE 2: Structured Object Mode (with JSON Schema)');
  console.log('═'.repeat(60));

  const { agent } = await createAgentWithClient(
    'Task Extractor',
    `You extract tasks from text. For each task, identify:
- A short title
- Priority (low, medium, high)  
- Due date if mentioned (use ISO format YYYY-MM-DD)
- Assignee if mentioned`
  );

  // Define JSON schema for structured output
  const taskListJsonSchema = jsonSchema<TaskList>({
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            dueDate: { type: 'string' },
            assignee: { type: 'string' },
          },
          required: ['title', 'priority'],
        },
      },
      summary: { type: 'string' },
      totalCount: { type: 'number' },
    },
    required: ['tasks', 'summary', 'totalCount'],
  });

  const userMessage = `
    Extract tasks from this message:
    
    "Hey team! Quick update: 
    - Mike needs to finish the API docs by Monday (high priority)
    - Someone should update the README, not urgent
    - Lisa will handle the deployment on 2024-03-15, critical!"
  `;

  console.log('\nInput:', userMessage.trim());
  console.log('\nGenerating response with mode: "object" + schema...\n');

  const result = await agent.generateResponse(
    [{ role: 'user', content: userMessage }],
    {
      output: {
        mode: 'object',
        schema: taskListJsonSchema,
      },
    }
  );

  // result.parsed is typed as TaskList
  const parsed = result.parsed as TaskList | undefined;

  if (parsed) {
    console.log('Structured Response (fully typed):');
    console.log('─'.repeat(40));
    console.log(`Summary: ${parsed.summary}`);
    console.log(`Total tasks: ${parsed.totalCount}`);
    console.log('\nTasks:');
    parsed.tasks.forEach((task, i) => {
      console.log(`  ${i + 1}. [${task.priority.toUpperCase()}] ${task.title}`);
      if (task.assignee) console.log(`     Assignee: ${task.assignee}`);
      if (task.dueDate) console.log(`     Due: ${task.dueDate}`);
    });
    console.log('─'.repeat(40));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 3: Sentiment Analysis with Schema
// Another practical example of structured output
// ═══════════════════════════════════════════════════════════════════════════

async function sentimentAnalysisExample() {
  console.log('\n' + '═'.repeat(60));
  console.log('EXAMPLE 3: Sentiment Analysis (Structured)');
  console.log('═'.repeat(60));

  const { agent } = await createAgentWithClient(
    'Sentiment Analyzer',
    `You analyze the sentiment of text. Provide:
- Overall sentiment (positive, negative, neutral, or mixed)
- Confidence score from 0 to 1
- Key phrases that influenced your analysis
- A one-sentence explanation`
  );

  const sentimentJsonSchema = jsonSchema<SentimentAnalysis>({
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'] },
      confidence: { type: 'number' },
      keywords: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['sentiment', 'confidence', 'keywords', 'summary'],
  });

  const testTexts = [
    "This product exceeded all my expectations! Fast shipping and great quality.",
    "The service was okay, nothing special. Delivery took longer than expected.",
    "Terrible experience. The item arrived broken and customer support was unhelpful.",
  ];

  for (const text of testTexts) {
    console.log('\nAnalyzing:', `"${text.substring(0, 50)}..."`);

    const result = await agent.generateResponse(
      [{ role: 'user', content: `Analyze the sentiment: "${text}"` }],
      {
        output: {
          mode: 'object',
          schema: sentimentJsonSchema,
        },
      }
    );

    const parsed = result.parsed as SentimentAnalysis | undefined;
    if (parsed) {
      const emoji =
        parsed.sentiment === 'positive' ? '😊' :
          parsed.sentiment === 'negative' ? '😞' :
            parsed.sentiment === 'mixed' ? '😐' : '😶';

      console.log(`  ${emoji} ${parsed.sentiment.toUpperCase()} (${(parsed.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`  Keywords: ${parsed.keywords.join(', ')}`);
      console.log(`  Summary: ${parsed.summary}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('SnapAgent SDK - Structured Output Examples');
  console.log('==========================================\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    console.error('Copy .env.example to .env and add your API key');
    process.exit(1);
  }

  try {
    // Run all examples
    await flexibleJsonExample();
    await structuredObjectExample();
    await sentimentAnalysisExample();

    console.log('\n' + '═'.repeat(60));
    console.log('All examples completed successfully!');
    console.log('═'.repeat(60) + '\n');

    console.log('Key takeaways:');
    console.log('─'.repeat(40));
    console.log('• mode: "json"   → Flexible, untyped JSON (result.parsed is unknown)');
    console.log('• mode: "object" → Validated against schema (result.parsed is typed)');
    console.log('• Use jsonSchema<T>() from "ai" package for type-safe schemas');
    console.log('• Schemas ensure consistent structure for downstream processing');
    console.log('─'.repeat(40) + '\n');

  } catch (error) {
    console.error('Error running examples:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Run if executed directly
const isMainModule = process.argv[1]?.includes('json-output');
if (isMainModule) {
  main().catch(console.error);
}
