# @snap-agent/rag-cms

Schema-agnostic CMS RAG plugin for SnapAgent SDK. Build chatbots for any website content — Drupal, WordPress, Contentful, or custom CMS.

## Features

- **Schema-Agnostic** - Only `id`, `content`, and `type` are required; store any metadata you need
- **Multi-CMS Support** - Works with Drupal JSON:API, WordPress REST, Contentful, or any JSON/CSV/XML source
- **Flexible Filtering** - Filter by any metadata field (type, category, author, tags, etc.)
- **Type Boosts** - Prioritize certain content types in search results
- **Recency Boost** - Automatically boost fresh content (great for news/blog)
- **URL Ingestion** - Fetch content directly from APIs with authentication
- **Drupal Integration** - Built-in helpers for Drupal JSON:API

## Installation

```bash
npm install @snap-agent/rag-cms @snap-agent/core mongodb
```

## Quick Start

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { CMSRAGPlugin } from '@snap-agent/rag-cms';

const cmsPlugin = new CMSRAGPlugin({
  mongoUri: process.env.MONGODB_URI!,
  dbName: 'my_website',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  tenantId: 'my-company',
  filterableFields: ['type', 'category', 'author'],
});

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Website Assistant',
  instructions: 'Help visitors find information on our website.',
  model: 'gpt-4o',
  userId: 'system',
  plugins: [cmsPlugin],
});
```

## Content Structure

Only three fields are required:

```typescript
interface CMSDocument {
  id: string;                    // Unique identifier
  content: string;               // Text to embed and search
  metadata: {
    type: string;                // Content type (e.g., 'blog', 'project', 'team')
    title?: string;              // Optional: Display title
    url?: string;                // Optional: Source URL
    [key: string]: any;          // Any other fields you need!
  };
}
```

### Example: Architecture Firm Website

```typescript
// Projects
await agent.ingestDocuments([{
  id: 'project-123',
  content: 'The Sahara West Library is a 65,000 SF public library featuring sustainable design...',
  metadata: {
    type: 'project',
    title: 'Sahara West Library',
    url: '/projects/sahara-west-library',
    location: 'Las Vegas, NV',
    sector: 'Cultural',
    services: ['Architecture', 'Interior Design'],
    completionYear: 2018,
    featured: true,
  }
}]);

// Team Members
await agent.ingestDocuments([{
  id: 'team-456',
  content: 'Jane Smith is a Principal and leads the Healthcare practice...',
  metadata: {
    type: 'team',
    title: 'Jane Smith',
    url: '/people/jane-smith',
    role: 'Principal',
    location: 'Phoenix',
    sectors: ['Healthcare', 'Science & Technology'],
  }
}]);

// News/Perspectives
await agent.ingestDocuments([{
  id: 'perspective-789',
  content: 'Biophilic design connects building occupants to nature...',
  metadata: {
    type: 'perspective',
    title: 'The Science of Biophilic Design',
    url: '/perspectives/biophilic-design',
    author: 'Jane Smith',
    publishedAt: '2024-01-15',
    tags: ['Sustainability', 'Wellness'],
  }
}]);
```

## CMS Integrations

Built-in helpers for popular CMS platforms:

### Drupal (JSON:API)

```typescript
await cmsPlugin.ingestFromDrupal({
  baseUrl: 'https://example-architecture.com',
  contentTypes: ['project', 'perspective', 'team_member', 'news'],
  auth: {
    type: 'bearer',
    token: process.env.DRUPAL_API_TOKEN,
  },
  mappings: {
    project: {
      content: 'attributes.body.processed',
      fields: {
        location: 'attributes.field_location',
        sector: 'attributes.field_sector.name',
        services: 'attributes.field_services',
      },
    },
    team_member: {
      content: 'attributes.field_bio.processed',
      fields: {
        role: 'attributes.field_title',
        sectors: 'attributes.field_sectors',
      },
    },
  },
});
```

### WordPress (REST API)

```typescript
await cmsPlugin.ingestFromWordPress({
  baseUrl: 'https://myblog.com',
  postTypes: ['posts', 'pages', 'portfolio'],  // Default: ['posts', 'pages']
  perPage: 100,   // Items per request
  maxPages: 10,   // Max pages to fetch
  auth: {
    type: 'basic',
    username: process.env.WP_USER,
    password: process.env.WP_APP_PASSWORD,
  },
  mappings: {
    portfolio: {
      content: 'content.rendered',
      fields: {
        client: 'acf.client_name',  // ACF custom fields
        industry: 'acf.industry',
      },
    },
  },
});
```

**Features:**
- Automatic pagination handling
- Embedded data (`_embed`) for authors, categories, featured images
- ACF (Advanced Custom Fields) support via custom mappings
- Custom post types

### Sanity.io (GROQ)

```typescript
await cmsPlugin.ingestFromSanity({
  projectId: 'abc123',
  dataset: 'production',
  apiVersion: 'v2024-01-01',  // Optional
  token: process.env.SANITY_TOKEN,  // For private datasets
  useCdn: true,  // Default: true (faster reads)
  queries: {
    post: {
      query: '*[_type == "post" && !(_id in path("drafts.**"))]',
      content: 'body',
      fields: {
        author: 'author->name',
        categories: 'categories[]->title',
        mainImage: 'mainImage.asset->url',
      },
    },
    page: {
      query: '*[_type == "page"]',
      content: 'content',
    },
  },
});

// Convert Portable Text to plain text
const plainText = CMSRAGPlugin.sanityBlocksToText(portableTextBlocks);
```

**Features:**
- GROQ query support for complex filtering
- Reference expansion (`->` operator)
- Portable Text to plain text conversion
- CDN and API endpoint support

### Strapi (v3 & v4)

```typescript
// Strapi v4 (default)
await cmsPlugin.ingestFromStrapi({
  baseUrl: 'https://my-strapi.com',
  apiToken: process.env.STRAPI_TOKEN,
  contentTypes: ['articles', 'pages', 'projects'],
  pageSize: 100,
  maxPages: 10,
  mappings: {
    articles: {
      content: 'attributes.content',
      fields: {
        author: 'attributes.author.data.attributes.name',
        category: 'attributes.category.data.attributes.name',
        featuredImage: 'attributes.cover.data.attributes.url',
      },
    },
  },
});

// Strapi v3 (set useAttributes: false)
await cmsPlugin.ingestFromStrapi({
  baseUrl: 'https://my-strapi-v3.com',
  contentTypes: ['articles'],
  mappings: {
    articles: {
      content: 'content',
      useAttributes: false,  // Strapi v3 uses flat structure
      fields: {
        author: 'author.name',
      },
    },
  },
});
```

**Features:**
- Strapi v3 and v4 support
- Automatic pagination
- Relation population (`populate=*`)
- Media/image URL extraction

## Zero-Setup Web Crawling

For non-technical clients who can't set up API access, use built-in web crawling:

### Sitemap Crawling

Just provide the sitemap URL — works with any website:

```typescript
// Simple - just the sitemap URL
await cmsPlugin.ingestFromSitemap({
  sitemapUrl: 'https://example.com/sitemap.xml',
});

// Or auto-discover sitemap from base URL
await cmsPlugin.ingestFromSitemap({
  baseUrl: 'https://example.com',
});

// Advanced - with content selectors and type inference
await cmsPlugin.ingestFromSitemap({
  sitemapUrl: 'https://example.com/sitemap.xml',
  maxPages: 500,
  concurrency: 3,        // Parallel requests
  delayMs: 500,          // Delay between requests
  
  // Content extraction
  contentSelector: 'article, .main-content, main',
  removeSelectors: ['nav', 'footer', '.sidebar', '.comments'],
  
  // URL filtering
  excludePatterns: ['/cart', '/checkout', '/admin', '/login'],
  includePatterns: ['/blog/', '/projects/', '/people/'],
  
  // Infer type from URL path
  typeFromUrl: {
    '/projects/': 'project',
    '/perspectives/': 'blog',
    '/people/': 'team',
    '/news/': 'news',
  },
});
```

**Features:**
- Auto-discovers sitemap from base URL
- Handles sitemap index files (nested sitemaps)
- Smart content extraction using CSS selectors
- URL pattern filtering (include/exclude)
- Content type inference from URL
- Rate limiting (concurrency + delay)
- Removes navigation, footers, sidebars

### Direct URL Crawling

Crawl specific pages:

```typescript
await cmsPlugin.ingestFromUrls([
  'https://example.com/about',
  'https://example.com/services',
  'https://example.com/contact',
  'https://example.com/pricing',
], {
  type: 'page',
  contentSelector: '.page-content',
  concurrency: 2,
});
```

### RSS/Atom Feeds

Ingest blog posts from RSS feeds:

```typescript
// Simple RSS ingestion
await cmsPlugin.ingestFromRSS({
  feedUrl: 'https://myblog.com/feed/',
  type: 'post',
});

// Fetch full article content (not just excerpt)
await cmsPlugin.ingestFromRSS({
  feedUrl: 'https://myblog.com/feed/',
  fetchFullContent: true,  // Crawl each article page
  contentSelector: 'article',
});
```

**Supported formats:**
- RSS 2.0
- RSS 1.0
- Atom

## URL Ingestion

Ingest from any JSON, CSV, or XML endpoint:

```typescript
// JSON API
await cmsPlugin.ingestFromUrl({
  url: 'https://api.example.com/posts',
  type: 'json',
  transform: {
    documentPath: 'data.posts',  // JSONPath to array
    fieldMapping: {
      id: 'post_id',
      content: 'body_html',
      type: () => 'blog',        // Static value
      title: 'title',
      author: 'author.name',
      publishedAt: 'created_at',
    },
  },
  auth: {
    type: 'bearer',
    token: process.env.API_TOKEN,
  },
});

// CSV file
await cmsPlugin.ingestFromUrl({
  url: 'https://example.com/content.csv',
  type: 'csv',
  transform: {
    fieldMapping: {
      id: 'ID',
      content: 'Description',
      type: 'ContentType',
      title: 'Title',
    },
  },
});
```

## Configuration

```typescript
const cmsPlugin = new CMSRAGPlugin({
  // Required
  mongoUri: process.env.MONGODB_URI!,
  dbName: 'my_website',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  tenantId: 'my-company',

  // Collection name (default: 'cms_content')
  collection: 'website_content',

  // Embedding model (default: 'text-embedding-3-small')
  embeddingModel: 'text-embedding-3-large',

  // Search settings
  vectorIndexName: 'content_vector_index',
  numCandidates: 100,
  limit: 10,
  minScore: 0.7,

  // Filterable fields for MongoDB indexing
  filterableFields: ['type', 'category', 'author', 'sector', 'tags'],

  // Boost certain content types
  typeBoosts: {
    project: 1.2,    // Projects rank higher
    news: 0.8,       // News ranks lower
    faq: 1.5,        // FAQs rank highest
  },

  // Boost recent content
  recencyBoost: {
    enabled: true,
    field: 'publishedAt',
    decayDays: 90,    // Content older than 90 days gets less boost
    maxBoost: 1.3,
  },

  // Caching
  cache: {
    embeddings: {
      enabled: true,
      ttl: 3600000,   // 1 hour
      maxSize: 1000,
    },
  },

  // Plugin priority
  priority: 100,
});
```

## Filtering in Queries

Filter by any metadata field during retrieval:

```typescript
// Get only projects
const response = await client.chat({
  threadId: thread.id,
  message: 'Show me healthcare projects in Phoenix',
  useRAG: true,
  ragFilters: {
    type: 'project',
    sector: 'Healthcare',
  },
});

// Get recent blog posts
const response = await client.chat({
  threadId: thread.id,
  message: 'Latest articles about sustainability',
  useRAG: true,
  ragFilters: {
    type: { $in: ['blog', 'perspective', 'news'] },
  },
});
```

## Multi-Agent Setup

Share content across agents or isolate by agent:

```typescript
// Shared content (available to all agents)
await cmsPlugin.ingest(documents);

// Agent-specific content
await cmsPlugin.ingest(documents, { agentId: 'sales-bot' });
await cmsPlugin.ingest(documents, { agentId: 'support-bot' });
```

## MongoDB Index Setup

Create a vector search index in MongoDB Atlas:

```json
{
  "name": "cms_vector_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      {
        "type": "vector",
        "path": "embedding",
        "numDimensions": 1536,
        "similarity": "cosine"
      },
      {
        "type": "filter",
        "path": "tenantId"
      },
      {
        "type": "filter",
        "path": "metadata.type"
      },
      {
        "type": "filter",
        "path": "agentId"
      }
    ]
  }
}
```

## API Reference

### Core Methods

| Method | Description |
|--------|-------------|
| `ingest(documents, options?)` | Ingest documents into the RAG system |
| `update(id, document, options?)` | Update a single document |
| `delete(ids, options?)` | Delete document(s) by ID |
| `bulk(operations, options?)` | Perform bulk insert/update/delete operations |
| `retrieveContext(message, options?)` | Retrieve relevant content (called by SDK) |

### CMS Integrations

| Method | CMS |
|--------|-----|
| `ingestFromDrupal(config, options?)` | Drupal JSON:API |
| `ingestFromWordPress(config, options?)` | WordPress REST API |
| `ingestFromSanity(config, options?)` | Sanity.io GROQ |
| `ingestFromStrapi(config, options?)` | Strapi v3 & v4 |

### Web Crawling (Zero Setup)

| Method | Description |
|--------|-------------|
| `ingestFromSitemap(config, options?)` | Crawl pages from sitemap.xml |
| `ingestFromUrls(urls, config?, options?)` | Crawl specific URLs |
| `ingestFromRSS(config, options?)` | Ingest from RSS/Atom feeds |

### URL Ingestion

| Method | Description |
|--------|-------------|
| `ingestFromUrl(source, options?)` | Ingest from JSON, CSV, or XML endpoint |

### Utilities

| Method | Description |
|--------|-------------|
| `getCacheStats()` | Get embedding cache statistics |
| `clearCache()` | Clear the embedding cache |
| `disconnect()` | Close MongoDB connection |
| `CMSRAGPlugin.sanityBlocksToText(blocks)` | Convert Portable Text to plain text |
| `CMSRAGPlugin.parseDrupalType(type)` | Parse Drupal node type |

## License

MIT

