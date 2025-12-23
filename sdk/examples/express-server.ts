/**
 * Express Server Example
 * 
 * This example demonstrates how to use the SnapAgent SDK in a production-ready Express API server
 * with Server-Sent Events (SSE) for streaming responses, thread listing, chat history,
 * and RAG document ingestion/management.
 * 
 * Features:
 * - Agent management (create, list)
 * - Thread management (create, list, messages)
 * - Chat with streaming support (SSE) and optional RAG context
 * - RAG document ingestion (bulk, update, delete)
 * - Health check endpoint
 * 
 * RAG Support:
 * - Ingest documents to an agent using POST /api/agents/:id/documents
 * - Enable RAG in chat by passing useRAG: true in the request body
 * - Optionally filter RAG results with ragFilters parameter
 * 
 */

import express, { Request, Response } from 'express';
import { createClient, MongoDBStorage, Models } from '../src';

const app = express();
app.use(express.json());

// Initialize SDK
const client = createClient({
  storage: new MongoDBStorage(process.env.MONGODB_URI || 'mongodb://localhost:27017/agents'),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  },
});

// ============================================================================
// Routes
// ============================================================================

// Create an agent
app.post('/api/agents', async (req: Request, res: Response) => {
  try {
    const { name, instructions, provider, model, userId } = req.body;

    const agent = await client.createAgent({
      name,
      instructions,
      provider: provider || 'openai',
      model: model || Models.OpenAI.GPT4O,
      userId,
    });

    res.json({
      success: true,
      agent: agent.toJSON(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List agents
app.get('/api/agents', async (req: Request, res: Response) => {
  try {
    const { userId, organizationId } = req.query;

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const agents = await client.listAgents(
      userId as string,
      organizationId as string | undefined
    );

    res.json({
      success: true,
      agents,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Create a thread
app.post('/api/threads', async (req: Request, res: Response) => {
  try {
    const { agentId, userId, name } = req.body;

    const thread = await client.createThread({
      agentId,
      userId,
      name,
    });

    res.json({
      success: true,
      thread: thread.toJSON(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List threads
app.get('/api/threads', async (req: Request, res: Response) => {
  try {
    const { userId, agentId, organizationId } = req.query;

    const threads = await client.listThreads({
      userId: userId as string | undefined,
      agentId: agentId as string | undefined,
      organizationId: organizationId as string | undefined,
    });

    res.json({
      success: true,
      threads,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Chat (non-streaming)
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { threadId, message, attachments, useRAG, ragFilters } = req.body;

    const response = await client.chat({
      threadId,
      message,
      attachments,
      useRAG,
      ragFilters,
    });

    res.json({
      success: true,
      response,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Chat with streaming (SSE)
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  const { threadId, message, attachments, useRAG, ragFilters } = req.body;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await client.chatStream(
      {
        threadId,
        message,
        attachments,
        useRAG,
        ragFilters,
      },
      {
        onChunk: (chunk) => {
          // Send each chunk as SSE data
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        },
        onComplete: (fullResponse, metadata) => {
          // Send completion event with metadata (includes RAG context info, latency, etc.)
          res.write(`data: ${JSON.stringify({ type: 'complete', content: fullResponse, metadata })}\n\n`);
          res.write('event: done\ndata: [DONE]\n\n');
          res.end();
        },
        onError: (error) => {
          // Send error event
          res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
          res.write('event: done\ndata: [DONE]\n\n');
          res.end();
        },
      }
    );
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error' })}\n\n`);
    res.write('event: done\ndata: [DONE]\n\n');
    res.end();
  }
});

// Get thread messages
app.get('/api/threads/:threadId/messages', async (req: Request, res: Response) => {
  try {
    const { threadId } = req.params;
    const { limit } = req.query;

    const thread = await client.getThread(threadId);
    const messages = await thread.getMessages(
      limit ? parseInt(limit as string) : undefined
    );

    res.json({
      success: true,
      messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// RAG Document Management Routes
// ============================================================================

// Ingest documents (bulk)
app.post('/api/agents/:agentId/documents', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const { documents, options } = req.body;

    if (!agentId) {
      res.status(400).json({
        success: false,
        error: 'agentId is required',
      });
      return;
    }

    if (!documents || !Array.isArray(documents)) {
      res.status(400).json({
        success: false,
        error: 'documents array is required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    const results = await agent.ingestDocuments(documents, options);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Update a single document
app.put('/api/agents/:agentId/documents/:documentId', async (req: Request, res: Response) => {
  try {
    const { agentId, documentId } = req.params;
    const { document, options } = req.body;

    if (!agentId || !documentId) {
      res.status(400).json({
        success: false,
        error: 'agentId and documentId are required',
      });
      return;
    }

    if (!document) {
      res.status(400).json({
        success: false,
        error: 'document object is required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    await agent.updateDocument(documentId, document, options);

    res.json({
      success: true,
      message: 'Document updated successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Delete document(s)
app.delete('/api/agents/:agentId/documents/:documentIds', async (req: Request, res: Response) => {
  try {
    const { agentId, documentIds } = req.params;
    const { options } = req.body;

    if (!agentId || !documentIds) {
      res.status(400).json({
        success: false,
        error: 'agentId and documentIds are required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    const ids = documentIds.includes(',') ? documentIds.split(',') : documentIds;
    const deletedCount = await agent.deleteDocuments(ids, options);

    res.json({
      success: true,
      deletedCount,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Bulk operations (insert, update, delete)
app.post('/api/agents/:agentId/documents/bulk', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const { operations, options } = req.body;

    if (!agentId) {
      res.status(400).json({
        success: false,
        error: 'agentId is required',
      });
      return;
    }

    if (!operations || !Array.isArray(operations)) {
      res.status(400).json({
        success: false,
        error: 'operations array is required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    const results = await agent.bulkDocumentOperations(operations, options);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Ingest documents from URL (CSV, JSON, API, XML)
app.post('/api/agents/:agentId/documents/ingest-url', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const { source, options } = req.body;

    if (!agentId) {
      res.status(400).json({
        success: false,
        error: 'agentId is required',
      });
      return;
    }

    if (!source || !source.url || !source.type) {
      res.status(400).json({
        success: false,
        error: 'source object with url and type is required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    const results = await agent.ingestFromUrl(source, options);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Handle webhook for real-time document updates
app.post('/api/agents/:agentId/webhook/:source', async (req: Request, res: Response) => {
  try {
    const { agentId, source } = req.params;
    const payload = req.body;
    const { options } = req.query;

    if (!agentId || !source) {
      res.status(400).json({
        success: false,
        error: 'agentId and source are required',
      });
      return;
    }

    const agent = await client.getAgent(agentId);
    const results = await agent.handleWebhook(
      payload,
      source,
      options ? JSON.parse(options as string) : undefined
    );

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    providers: client.getConfiguredProviders(),
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
  Server running on http://localhost:${PORT}

  Agent Management:
    POST   /api/agents                           - Create agent
    GET    /api/agents                           - List agents

  Thread Management:
    POST   /api/threads                          - Create thread
    GET    /api/threads                          - List threads
    GET    /api/threads/:id/messages             - Get messages

  Chat:
    POST   /api/chat                             - Chat (non-streaming)
    POST   /api/chat/stream                      - Chat with streaming (SSE)

  RAG Document Management:
    POST   /api/agents/:id/documents             - Ingest documents (bulk)
    PUT    /api/agents/:id/documents/:docId      - Update document
    DELETE /api/agents/:id/documents/:docIds     - Delete document(s)
    POST   /api/agents/:id/documents/bulk        - Bulk operations
    POST   /api/agents/:id/documents/ingest-url  - Ingest from URL (CSV/JSON/API)
    POST   /api/agents/:id/webhook/:source       - Handle webhook updates

  Health:
    GET    /health                               - Health check

  Configured providers: ${client.getConfiguredProviders().join(', ')}
  `);
});

