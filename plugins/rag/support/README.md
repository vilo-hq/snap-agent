# @snap-agent/rag-support

Customer Support RAG plugin for SnapAgent SDK - Search tickets, FAQs, and support history.

## Features

- **Ticket Search** - Find similar issues and their resolutions
- **FAQ Retrieval** - Semantic search over frequently asked questions
- **Smart Ranking** - Resolved tickets and FAQs boosted for relevance
- **Category Filtering** - Filter by category, tags, status
- **Time-Based** - Configurable ticket age limits
- **History-Aware** - Includes conversation history in context  

## Installation

```bash
npm install @snap-agent/rag-support @snap-agent/core
```

## Quick Start

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { SupportRAGPlugin } from '@snap-agent/rag-support';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Support Assistant',
  instructions: 'You help customers by finding relevant solutions.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new SupportRAGPlugin({
      embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
    }),
  ],
});

// Get the plugin instance for specialized methods
const supportPlugin = agent.getPlugin('support-rag') as SupportRAGPlugin;

// Ingest FAQs
await supportPlugin.ingestFAQs([
  {
    id: 'faq-1',
    question: 'How do I reset my password?',
    answer: 'Go to Settings > Security > Reset Password. You will receive an email with reset instructions.',
    category: 'account',
    tags: ['password', 'security'],
  },
  {
    id: 'faq-2',
    question: 'What payment methods do you accept?',
    answer: 'We accept Visa, MasterCard, American Express, PayPal, and bank transfers.',
    category: 'billing',
    tags: ['payment', 'billing'],
  },
], { agentId: agent.id });

// Ingest resolved tickets
await supportPlugin.ingestTickets([
  {
    id: 'ticket-123',
    subject: 'Cannot log in after password reset',
    description: 'Customer tried to reset password but cannot log in with new password.',
    resolution: 'Cache was causing issues. Clearing browser cache and cookies resolved the issue.',
    status: 'resolved',
    category: 'account',
    tags: ['login', 'password'],
    createdAt: new Date('2024-01-15'),
    resolvedAt: new Date('2024-01-15'),
  },
], { agentId: agent.id });

// Query
const response = await client.chat({
  threadId: thread.id,
  message: 'I can\'t log into my account after changing my password',
  useRAG: true,
});
```

## Configuration

```typescript
const plugin = new SupportRAGPlugin({
  // Required
  embeddingProviderApiKey: process.env.OPENAI_API_KEY!,

  // Search
  limit: 5,               // Results to return
  minSimilarity: 0.65,    // Minimum similarity score

  // Boosting
  resolvedBoost: 1.2,     // Boost for resolved tickets (have solutions)
  faqBoost: 1.3,          // Boost for FAQs (authoritative answers)

  // Content
  includeHistory: true,   // Include conversation history
  maxTicketAgeDays: 365,  // Only include tickets from last year (0 = no limit)

  // Embeddings
  embeddingModel: 'text-embedding-3-small',
});
```

## Document Types

### Support Tickets

```typescript
interface SupportTicket {
  id: string;
  subject: string;
  description: string;
  resolution?: string;          // Solution (if resolved)
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  category?: string;
  tags?: string[];
  customerId?: string;
  createdAt: Date;
  resolvedAt?: Date;
  messages?: Array<{            // Conversation history
    role: 'customer' | 'agent' | 'system';
    content: string;
    timestamp: Date;
  }>;
}

// Ingest using specialized method
await supportPlugin.ingestTickets([ticket1, ticket2], { agentId });
```

### FAQ Entries

```typescript
interface FAQEntry {
  id: string;
  question: string;
  answer: string;
  category?: string;
  tags?: string[];
  helpful?: number;      // Helpful votes
  notHelpful?: number;   // Not helpful votes
}

// Ingest using specialized method
await supportPlugin.ingestFAQs([faq1, faq2], { agentId });
```

### General Articles

```typescript
await agent.ingestDocuments([
  {
    id: 'article-1',
    content: 'Your help article content...',
    metadata: {
      type: 'article',
      title: 'How to Use Feature X',
      category: 'tutorials',
      tags: ['feature-x', 'tutorial'],
    },
  },
]);
```

## Filtering Results

```typescript
const response = await client.chat({
  threadId: thread.id,
  message: 'Payment failed',
  useRAG: true,
  ragFilters: {
    type: 'faq',              // Only FAQs
    category: 'billing',      // Only billing category
    status: 'resolved',       // Only resolved tickets
    tags: ['payment'],        // Must have these tags
  },
});
```

## Response Context Format

The plugin formats context to prioritize the most useful information:

```
## Frequently Asked Questions

**Q: What payment methods do you accept?**
A: We accept Visa, MasterCard, American Express...

## Similar Resolved Issues

### Payment failed for subscription renewal
**Problem:** Customer's card was declined during renewal.
**Solution:** Card had expired. Customer updated card details...

## Related Help Articles

Content from relevant help articles...
```

## Response Metadata

```typescript
const response = await client.chat({
  threadId: thread.id,
  message: 'How do I cancel?',
  useRAG: true,
});

console.log(response.metadata);
// {
//   count: 4,
//   totalDocuments: 150,
//   byType: { faq: 2, ticket: 1, article: 1 },
//   sources: [
//     { id: 'faq-5', type: 'faq', score: 0.91, category: 'billing' },
//     { id: 'ticket-89', type: 'ticket', score: 0.85, status: 'resolved' },
//     ...
//   ]
// }
```

## API Reference

### `SupportRAGPlugin`

#### Constructor
```typescript
new SupportRAGPlugin(config: SupportRAGConfig)
```

#### Methods

| Method | Description |
|--------|-------------|
| `retrieveContext(message, options)` | Search support content |
| `ingest(documents, options)` | Index generic documents |
| `ingestTickets(tickets, options)` | Index support tickets |
| `ingestFAQs(faqs, options)` | Index FAQ entries |
| `update(id, document, options)` | Update a document |
| `delete(ids, options)` | Remove documents |
| `getStats()` | Get indexing statistics |
| `clearAgent(agentId)` | Clear agent's data |
| `clearAll()` | Clear all data |

## Use Cases

- **Customer Support Bots** - Find solutions to common issues
- **Help Desk Automation** - Auto-suggest responses
- **Knowledge Base Search** - Semantic FAQ search
- **Ticket Routing** - Find similar tickets for routing
- **Agent Assist** - Help human agents find solutions faster

## Integration Example

### With Zendesk Tickets

```typescript
// Fetch from Zendesk API
const zendeskTickets = await fetchZendeskTickets();

// Transform to SupportTicket format
const tickets = zendeskTickets.map(t => ({
  id: `zendesk-${t.id}`,
  subject: t.subject,
  description: t.description,
  resolution: t.custom_fields?.resolution,
  status: mapZendeskStatus(t.status),
  category: t.group_id,
  tags: t.tags,
  createdAt: new Date(t.created_at),
}));

await supportPlugin.ingestTickets(tickets, { agentId });
```

### With Intercom

```typescript
const intercomArticles = await fetchIntercomArticles();

const faqs = intercomArticles.map(a => ({
  id: `intercom-${a.id}`,
  question: a.title,
  answer: a.body,
  category: a.parent_id,
}));

await supportPlugin.ingestFAQs(faqs, { agentId });
```

## License

MIT © ViloTech

