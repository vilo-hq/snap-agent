# 📄 Formatos de Documentos Soportados

## 🏗️ Arquitectura de Parsing

**DocsRAGPlugin acepta solo texto plano (`string`)**. El parsing de cualquier formato **es responsabilidad de tu aplicación**.

```
┌─────────────────┐
│ Tu Aplicación   │
├─────────────────┤
│  PDF Parser     │──┐
│  DOCX Parser    │  │
│  HTML Parser    │  ├─> Texto plano
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

### 🎯 Separación de Responsabilidades

| Componente | Responsabilidad |
|------------|----------------|
| **Tu App** | Leer archivos, parsear formatos, extraer texto |
| **Plugin** | Chunking, embeddings, almacenamiento, búsqueda |

---

## 📚 Formatos y Librerías

### 1️⃣ **Markdown** (.md)

**✅ Más recomendado** - Parsing nativo, soporte completo

```bash
# No requiere librerías adicionales
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

**Chunking Strategy:** `markdown` (respeta headers)

---

### 2️⃣ **PDF** (.pdf)

**Librería:** [`pdf-parse`](https://www.npmjs.com/package/pdf-parse)

```bash
pnpm add pdf-parse
pnpm add -D @types/pdf-parse
```

```typescript
import pdf from 'pdf-parse';
import { readFileSync } from 'fs';

const dataBuffer = readFileSync('document.pdf');
const data = await pdf(dataBuffer);

await plugin.ingest([{
  id: 'document',
  content: data.text,
  metadata: {
    type: 'pdf',
    pages: data.numpages,
    info: data.info
  }
}]);
```

**Ver ejemplo completo:** [sdk/examples/docs-rag/ingest-pdf.ts](../../../sdk/examples/docs-rag/ingest-pdf.ts)

**Chunking Strategy:** `paragraph` o `fixed`

**⚠️ Limitaciones:**
- No extrae imágenes
- Tablas pueden perder formato
- PDFs escaneados (OCR) requieren procesamiento adicional

---

### 3️⃣ **Microsoft Word** (.docx)

**Librería:** [`mammoth`](https://www.npmjs.com/package/mammoth)

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
  content: result.value, // Markdown generado
  metadata: {
    type: 'docx',
    warnings: result.messages
  }
}]);
```

**Ver ejemplo completo:** [sdk/examples/docs-rag/ingest-docx.ts](../../../sdk/examples/docs-rag/ingest-docx.ts)

**Chunking Strategy:** `markdown` (convierte a MD primero)

**✨ Ventajas:**
- Preserva formato (negrita, cursiva, listas)
- Convierte a Markdown automáticamente
- Extrae estilos de párrafos

---

### 4️⃣ **HTML** (.html, URLs)

**Librerías:** [`cheerio`](https://www.npmjs.com/package/cheerio) + [`html-to-text`](https://www.npmjs.com/package/html-to-text)

```bash
pnpm add cheerio html-to-text
```

```typescript
import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';

// Desde archivo
const html = readFileSync('page.html', 'utf-8');

// O desde URL
const response = await fetch('https://docs.example.com');
const html = await response.text();

// Limpiar con Cheerio
const $ = cheerio.load(html);
$('script, style, nav, footer').remove();

const mainContent = $('main').html() || $('body').html();

// Convertir a texto plano
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

**Ver ejemplo completo:** [sdk/examples/docs-rag/ingest-html.ts](../../../sdk/examples/docs-rag/ingest-html.ts)

**Chunking Strategy:** `paragraph`

**🎯 Uso ideal:**
- Scraping de documentación web
- Ingesta de wikis
- Crawling de sitios

---

### 5️⃣ **Código Fuente** (.ts, .js, .py, .java, etc.)

**✅ No requiere librerías** - Leer como texto plano

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

**Ver ejemplo completo:** [sdk/examples/docs-rag/ingest-code.ts](../../../sdk/examples/docs-rag/ingest-code.ts)

**Chunking Strategy:** `fixed` (mejor para código)

**Lenguajes soportados:**
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

### 6️⃣ **Texto Plano** (.txt)

**✅ Soporte nativo**

```typescript
const text = readFileSync('notes.txt', 'utf-8');

await plugin.ingest([{
  id: 'notes',
  content: text,
  metadata: { type: 'text' }
}]);
```

**Chunking Strategy:** `paragraph` o `sentence`

---

### 7️⃣ **JSON/YAML** (Configuración)

**Para documentación de APIs o configs**

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

## 🔄 Flujo Completo de Ingesta

```typescript
// 1. Tu aplicación parsea el archivo
const parsedText = await parseFile('document.pdf');

// 2. DocsRAGPlugin procesa el texto
const result = await plugin.ingest([{
  id: 'unique-doc-id',
  content: parsedText, // ← Solo texto plano
  metadata: {
    title: 'Mi Documento',
    type: 'pdf',
    source: 'uploads/doc.pdf',
    // ... más metadata
  }
}], {
  agentId: 'my-agent'
});

// 3. Plugin automáticamente:
//    - Divide en chunks
//    - Genera embeddings
//    - Almacena en MongoDB
//    - Crea índice vectorial
```

---

## 🚀 Casos de Uso por Formato

| Formato | Caso de Uso | Chunking |
|---------|-------------|----------|
| **Markdown** | Documentación técnica, READMEs | `markdown` |
| **PDF** | Manuales, libros, papers | `paragraph` |
| **DOCX** | Documentos corporativos, reportes | `markdown` |
| **HTML** | Wikis, docs web, blogs | `paragraph` |
| **Código** | Search de implementaciones, docs automáticas | `fixed` |
| **TXT** | Notas, logs, transcripciones | `sentence` |

---

## 💡 Recomendaciones

### ✅ DO

- **Parsea en tu aplicación** antes de llamar `ingest()`
- **Extrae metadata relevante** (título, autor, fecha, etc.)
- **Limpia el contenido** (remueve headers/footers innecesarios)
- **Usa chunking strategy apropiada** para cada formato
- **Valida el texto extraído** antes de ingerir

### ❌ DON'T

- No envíes buffers binarios a `ingest()`
- No ingieras contenido sin procesar (HTML con scripts, etc.)
- No uses `markdown` strategy con código o PDFs
- No ingieras archivos muy grandes sin dividir primero
- No olvides manejar errores de parsing

---

## 🛠️ Paquete Helper (Futuro)

Si necesitas parsing out-of-the-box, considera crear:

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

**Ventajas:**
- Detección automática de formato
- Configuración unificada
- Manejo de errores consistente
- Optimizaciones específicas

---

## 📞 Soporte

¿Necesitas soporte para otro formato?

1. Busca una librería de parsing en npm
2. Extrae el texto
3. Pásalo a `ingest()`

**Ejemplos:**
- **Excel** → `xlsx` → exportar a CSV/texto
- **RTF** → `rtf-parser` → texto plano
- **Imágenes (OCR)** → `tesseract.js` → texto extraído
- **Diagramas** → `mermaid` → descripción texto

---

## 🔗 Referencias

- [Examples Directory](../../../sdk/examples/docs-rag/) - Código completo para cada formato
- [DocsRAGPlugin API](./README.md#api-reference) - Referencia completa
- [Chunking Strategies](./README.md#chunking-strategies) - Detalles de cada estrategia
