# DocsRAG Plugin Examples

Usage examples for **DocsRAGPlugin** with different document formats.

## 📋 Prerequisites

1. **Install monorepo dependencies:**
   ```bash
   # From the monorepo root
   pnpm install
   ```

   These examples import directly from the plugin source code in `plugins/rag/docs/src/`, not from the published package.

2. **Configure .env:**
   ```bash
   cd sdk/examples/docs-rag
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Create a vector search index in MongoDB Atlas:**
   - Follow the guide: `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`
   - Or see: `plugins/rag/docs/README.md#mongodb-setup`

## 🔧 Available Scripts

### 1. Verify Configuration

Verifies that MongoDB and the vector index are configured correctly:

```bash
cd sdk/examples/docs-rag
npx tsx verify-index.ts
```

### 2. Basic Plugin Test

Full test using a sample document:

```bash
cd sdk/examples/docs-rag
npx tsx test-plugin.ts
```

This will:
- ✅ Ingest a sample markdown document
- ✅ Run 3 test queries
- ✅ Show cache statistics
- ✅ Verify persistence

### 3. Agent Persistence (End-to-End)

Verifies that DocsRAGPlugin correctly implements `getConfig()` for persistence:

```bash
cd sdk/examples/docs-rag
npx tsx agent-persistence.ts
```

**This example verifies:**
- ✅ DocsRAGPlugin has a `getConfig()` method
- ✅ The configuration is JSON serializable
- ✅ Sensitive values use environment variable references (for example `${MONGODB_URI}`)
- ✅ PluginRegistry can re-instantiate the plugin from stored config
- ✅ The plugin works correctly with an agent
- ✅ The configuration is saved to MongoDB

**Verification flow:**
1. Create a `DocsRAGPlugin` instance
2. Call `getConfig()` to obtain the serializable configuration
3. Verify that sensitive values use environment variable references
4. Register the plugin in `PluginRegistry`
5. Simulate re-instantiation from stored config
6. Create an agent with the plugin
7. Verify that the plugin works correctly (ingest and search)

**What this demonstrates:**
When you reload an agent from MongoDB, the SDK:
1. Reads the `pluginConfigs` array from the database
2. Calls `pluginRegistry.instantiate(config)` for each stored config
3. Resolves environment variables in the registry (for example `${MONGODB_URI}` → real URI)
4. Calls the factory function with the resolved config
5. Creates a new plugin instance from that config
6. Makes the reloaded agent work with the re-instantiated plugins

> 💡 This example proves that the persistence bug is **fixed** for DocsRAGPlugin, EcommerceRAGPlugin, and SupportRAGPlugin (all of them now implement `getConfig()`).

---

## 📄 Format Examples

### PDF Files

**Install:**
```bash
pnpm add pdf-parse -D @types/pdf-parse
```

**Run:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-pdf.ts path/to/document.pdf
```

**Features:**
- Extracts text from PDFs
- Preserves metadata (pages, author, date)
- Uses `paragraph` chunking

---

### DOCX Files (Microsoft Word)

**Install:**
```bash
pnpm add mammoth
```

**Run:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-docx.ts path/to/document.docx
```

**Features:**
- Converts content to markdown
- Preserves formatting (bold, italics, lists)
- Uses `markdown` chunking

---

### HTML (Web Pages or Files)

**Install:**
```bash
pnpm add cheerio html-to-text
```

**Run:**
```bash
# From a URL
cd sdk/examples/docs-rag
npx tsx ingest-html.ts https://example.com/docs

# From a file
npx tsx ingest-html.ts path/to/file.html
```

**Features:**
- Scrapes web content
- Removes scripts, styles, and navigation
- Extracts main content
- Converts to plain text

---

### Source Code (TypeScript, JavaScript, Python, etc.)

**Run:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-code.ts /path/to/codebase
```

**Features:**
- Scans directories recursively
- Supports 12+ languages
- Ignores `node_modules`, `dist`, `.git`
- Uses `fixed` chunking (better for code)
- Enables semantic search for implementations

**Supported languages:**
- TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`)
- Python (`.py`)
- Java (`.java`)
- C# (`.cs`)
- Go (`.go`)
- Rust (`.rs`)
- C/C++ (`.c`, `.cpp`)
- Ruby (`.rb`)
- PHP (`.php`)
- Swift (`.swift`)
- Kotlin (`.kt`)

---

## 🏗️ File Structure

```
sdk/examples/docs-rag/
├── .env.example          # Configuration template
├── README.md             # This guide
├── verify-index.ts       # Verify MongoDB setup
├── test-plugin.ts        # Full basic test
├── agent-persistence.ts  # ⭐ Full persistence flow (E2E)
├── ingest-pdf.ts         # PDF example
├── ingest-docx.ts        # DOCX example
├── ingest-html.ts        # HTML/Web example
└── ingest-code.ts        # Source code example
```

## 📚 Additional Documentation

- **Plugin README:** `plugins/rag/docs/README.md`
- **Setup Guide:** `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`
- **Troubleshooting:** `plugins/rag/docs/TROUBLESHOOTING.md`
- **Supported formats:** `plugins/rag/docs/SUPPORTED_FORMATS.md`
- **Quick Start:** `plugins/rag/docs/QUICKSTART.md`

## 🚀 Next Steps

1. **Run verify-index.ts** to confirm the configuration
2. **Run test-plugin.ts** to verify everything works
3. **Try the examples** with your own documents
4. **Integrate into your application** using these examples as reference

## 💡 Tips

- **Chunking Strategy:**
  - Use `markdown` for structured docs
  - Use `paragraph` for PDFs and HTML
  - Use `fixed` for source code
  - Use `sentence` for plain text

- **Embedding Cache:**
  - Reduces OpenAI API costs
  - Improves performance
  - Check stats with `cacheHits` and `cacheMisses`

- **Persistent Storage:**
  - Documents are stored in MongoDB
  - You do not need to re-ingest after restarting
  - You can update or delete documents individually

## ❓ Common Problems

**Error: "vector search index not found"**
- Create the vector index in the Atlas UI
- Follow: `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`

**Error: "MONGODB_URI is not set"**
- Create the `.env` file in this directory
- Copy from `.env.example` and edit it

**Error: "listSearchIndexes() not supported"**
- Requires MongoDB Atlas M10+ tier
- Free tier (M0) does NOT support vector search

See more in: `plugins/rag/docs/TROUBLESHOOTING.md`
