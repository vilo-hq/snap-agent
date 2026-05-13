# 📄 Supported Document Formats

## 🏗️ Parsing Architecture

**DocsRAGPlugin accepts only plain text (`string`)**. Parsing any format **is your application's responsibility**.

```
┌─────────────────┐
│ Your Application│
├─────────────────┤
│  PDF Parser     │──┐
│  DOCX Parser    │  │
│  HTML Parser    │  ├─> Plain text
│  MD Parser      │  │
│  Code Parser    │──┘
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ DocsRAGPlugin   │
├─────────────────┤
│  - Chunking     │
│  - Embeddings   │
│  - Vector Index │
│  - Search       │
└─────────────────┘
```

### 🎯 Separation of Concerns

| Component | Responsibility |
|-----------|---------------|
| **Your App** | Read files, parse formats, extract text |
| **Plugin** | Chunking, embeddings, storage, search |

---

## 📚 Formats and Libraries

### 1️⃣ **Markdown** (.md)

**✅ Most recommended** - Native parsing, full support

```bash
# No additional libraries required
```

```typescript
import { readFileSync } from 'fs';

const markdown = readFileSync('docs/guide.md', 'utf-8');

await plugin.ingest([{
  id: 'guide',
  content: markdown,
  metadata: { type: 'markdown' }
}]);
```

**Chunking Strategy:** `markdown` (respects headers)

---

### 2️⃣ **PDF** (.pdf)

**Library:** [`unpdf`](https://www.npmjs.com/package/unpdf) (PDF.js, ESM-friendly; recommended over `pdf-parse` for Node/tsx and serverless)

```bash
pnpm add unpdf
```

```typescript
import { readFileSync } from 'fs';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';

const bytes = new Uint8Array(readFileSync('document.pdf'));
const pdf = await getDocumentProxy(bytes);
const { totalPages, text } = await extractText(pdf, { mergePages: true });
const { info } = await getMeta(pdf).catch(() => ({ info: {} }));

await plugin.ingest([{
  id: 'document',
  content: text,
  metadata: {
    type: 'pdf',
    pages: totalPages,
    title: typeof info.Title === 'string' ? info.Title : undefined,
  }
}], { agentId: 'my-agent' });
```

**See full example:** [sdk/examples/docs-rag/ingest-pdf.ts](../../../sdk/examples/docs-rag/ingest-pdf.ts)

**Chunking Strategy:** `paragraph` or `fixed`

**⚠️ Limitations:**
- Does not extract images
- Tables may lose formatting
- Scanned PDFs (OCR) require additional processing

---

### 3️⃣ **Microsoft Word** (.docx)

**Library:** [`mammoth`](https://www.npmjs.com/package/mammoth)

```bash
pnpm add mammoth
```

```typescript
import mammoth from 'mammoth';

const result = await mammoth.convertToMarkdown({ 
  path: 'document.docx' 
});

await plugin.ingest([{
  id: 'document',
  content: result.value, // Generated Markdown
  metadata: {
    type: 'docx',
    warnings: result.messages
  }
}]);
```

**See full example:** [sdk/examples/docs-rag/ingest-docx.ts](../../../sdk/examples/docs-rag/ingest-docx.ts)

**Chunking Strategy:** `markdown` (converts to MD first)

**✨ Advantages:**
- Preserves formatting (bold, italic, lists)
- Automatically converts to Markdown
- Extracts paragraph styles

---

### 4️⃣ **HTML** (.html, URLs)

**Libraries:** [`cheerio`](https://www.npmjs.com/package/cheerio) + [`html-to-text`](https://www.npmjs.com/package/html-to-text)

```bash
pnpm add cheerio html-to-text
```

```typescript
import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';

// From file
const html = readFileSync('page.html', 'utf-8');

// Or from URL
const response = await fetch('https://docs.example.com');
const html = await response.text();

// Clean with Cheerio
const $ = cheerio.load(html);
$('script, style, nav, footer').remove();

const mainContent = $('main').html() || $('body').html();

// Convert to plain text
const text = convert(mainContent, {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true }},
    { selector: 'img', format: 'skip' }
  ]
});

await plugin.ingest([{
  id: 'page',
  content: text,
  metadata: {
    type: 'html',
    title: $('title').text(),
    url: 'https://...'
  }
}]);
```

**See full example:** [sdk/examples/docs-rag/ingest-html.ts](../../../sdk/examples/docs-rag/ingest-html.ts)

**Chunking Strategy:** `paragraph`

**🎯 Ideal use cases:**
- Web documentation scraping
- Wiki ingestion
- Site crawling

---

### 5️⃣ **Source Code** (.ts, .js, .py, .java, etc.)

**✅ No libraries required** - Read as plain text

```typescript
import { readFileSync, readdirSync } from 'fs';
import { extname } from 'path';

const code = readFileSync('src/index.ts', 'utf-8');

await plugin.ingest([{
  id: 'index-ts',
  content: code,
  metadata: {
    type: 'code',
    language: 'typescript',
    lines: code.split('\n').length
  }
}]);
```

**See full example:** [sdk/examples/docs-rag/ingest-code.ts](../../../sdk/examples/docs-rag/ingest-code.ts)

**Chunking Strategy:** `fixed` (best for code)

**Supported languages:**
- TypeScript/JavaScript (.ts, .tsx, .js, .jsx)
- Python (.py)
- Java (.java)
- C# (.cs)
- Go (.go)
- Rust (.rs)
- C/C++ (.c, .cpp)
- Ruby (.rb)
- PHP (.php)
- Swift (.swift)
- Kotlin (.kt)

---

### 6️⃣ **Plain Text** (.txt)

**✅ Native support**

```typescript
const text = readFileSync('notes.txt', 'utf-8');

await plugin.ingest([{
  id: 'notes',
  content: text,
  metadata: { type: 'text' }
}]);
```

**Chunking Strategy:** `paragraph` or `sentence`

---

### 7️⃣ **JSON/YAML** (Configuration)

**For API documentation or configs**

```typescript
import yaml from 'js-yaml';

// JSON
const config = JSON.parse(readFileSync('config.json', 'utf-8'));
const text = JSON.stringify(config, null, 2);

// YAML
const yamlDoc = yaml.load(readFileSync('config.yaml', 'utf-8'));
const text = yaml.dump(yamlDoc);

await plugin.ingest([{
  id: 'config',
  content: text,
  metadata: { type: 'config', format: 'json' }
}]);
```

**Chunking Strategy:** `fixed`

---

## 🔄 Complete Ingestion Flow

```typescript
// 1. Your application parses the file
const parsedText = await parseFile('document.pdf');

// 2. DocsRAGPlugin processes the text
const result = await plugin.ingest([{
  id: 'unique-doc-id',
  content: parsedText, // ← Plain text only
  metadata: {
    title: 'My Document',
    type: 'pdf',
    source: 'uploads/doc.pdf',
    // ... more metadata
  }
}], {
  agentId: 'my-agent'
});

// 3. Plugin automatically:
//    - Splits into chunks
//    - Generates embeddings
//    - Stores in MongoDB
//    - Creates vector index
```

---

## 🚀 Use Cases by Format

| Format | Use Case | Chunking |
|--------|----------|----------|
| **Markdown** | Technical documentation, READMEs | `markdown` |
| **PDF** | Manuals, books, papers | `paragraph` |
| **DOCX** | Corporate documents, reports | `markdown` |
| **HTML** | Wikis, web docs, blogs | `paragraph` |
| **Code** | Implementation search, auto-generated docs | `fixed` |
| **TXT** | Notes, logs, transcriptions | `sentence` |

---

## 💡 Recommendations

### ✅ DO

- **Parse in your application** before calling `ingest()`
- **Extract relevant metadata** (title, author, date, etc.)
- **Clean the content** (remove unnecessary headers/footers)
- **Use the appropriate chunking strategy** for each format
- **Validate extracted text** before ingesting

### ❌ DON'T

- Don't send binary buffers to `ingest()`
- Don't ingest unprocessed content (HTML with scripts, etc.)
- Don't use `markdown` strategy with code or PDFs
- Don't ingest very large files without splitting first
- Don't forget to handle parsing errors

---

## 🛠️ Helper Package (Future)

If you need out-of-the-box parsing, consider creating:

```bash
@snap-agent/rag-helpers
```

```typescript
import { parseDocument } from '@snap-agent/rag-helpers';

const text = await parseDocument('file.pdf', {
  type: 'auto-detect',
  cleanHTML: true,
  extractTables: true
});

await plugin.ingest([{ id: 'doc', content: text }]);
```

**Advantages:**
- Automatic format detection
- Unified configuration
- Consistent error handling
- Format-specific optimizations

---

## 📞 Support

Need support for another format?

1. Find a parsing library on npm
2. Extract the text
3. Pass it to `ingest()`

**Examples:**
- **Excel** → `xlsx` → export to CSV/text
- **RTF** → `rtf-parser` → plain text
- **Images (OCR)** → `tesseract.js` → extracted text
- **Diagrams** → `mermaid` → text description

---

## 🔗 References

- [Examples Directory](../../../sdk/examples/docs-rag/) - Complete code for each format
- [DocsRAGPlugin API](./README.md#api-reference) - Full reference
- [Chunking Strategies](./README.md#chunking-strategies) - Details on each strategy
