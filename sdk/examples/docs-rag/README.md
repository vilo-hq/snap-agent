# DocsRAG Plugin Examples

Ejemplos de uso del **DocsRAGPlugin** con diferentes formatos de documentos.

## 📋 Requisitos Previos

1. **Instalar dependencias del monorepo:**
   ```bash
   # Desde la raíz del monorepo
   pnpm install
   ```
   
   Los ejemplos importan directamente desde el código fuente del plugin en `plugins/rag/docs/src/`, no del paquete publicado.

2. **Configurar .env:**
   ```bash
   cd sdk/examples/docs-rag
   cp .env.example .env
   # Editar .env con tus credenciales
   ```

3. **Crear vector search index en MongoDB Atlas:**
   - Seguir la guía: `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`
   - O ver: `plugins/rag/docs/README.md#mongodb-setup`

## 🔧 Scripts Disponibles

### 1. Verificar Configuración

Verifica que MongoDB y el vector index estén correctamente configurados:

```bash
cd sdk/examples/docs-rag
npx tsx verify-index.ts
```

### 2. Test Básico del Plugin

Prueba completa con documento de ejemplo:

```bash
cd sdk/examples/docs-rag
npx tsx test-plugin.ts
```

Esto:
- ✅ Ingiere un documento markdown de ejemplo
- ✅ Hace 3 queries de prueba
- ✅ Muestra estadísticas de caché
- ✅ Verifica persistencia

---

## 📄 Ejemplos por Formato

### PDF Files

**Instalar:**
```bash
pnpm add pdf-parse -D @types/pdf-parse
```

**Ejecutar:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-pdf.ts path/to/document.pdf
```

**Características:**
- Extrae texto de PDFs
- Preserva metadata (páginas, autor, fecha)
- Usa chunking `paragraph`

---

### DOCX Files (Microsoft Word)

**Instalar:**
```bash
pnpm add mammoth
```

**Ejecutar:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-docx.ts path/to/document.docx
```

**Características:**
- Convierte a markdown
- Preserva formato (negrita, cursiva, listas)
- Usa chunking `markdown`

---

### HTML (Páginas web o archivos)

**Instalar:**
```bash
pnpm add cheerio html-to-text
```

**Ejecutar:**
```bash
# Desde URL
cd sdk/examples/docs-rag
npx tsx ingest-html.ts https://example.com/docs

# Desde archivo
npx tsx ingest-html.ts path/to/file.html
```

**Características:**
- Scraping de contenido web
- Limpia scripts, estilos, navegación
- Extrae contenido principal
- Convierte a texto plano

---

### Código Fuente (TypeScript, JavaScript, Python, etc.)

**Ejecutar:**
```bash
cd sdk/examples/docs-rag
npx tsx ingest-code.ts /path/to/codebase
```

**Características:**
- Escanea directorios recursivamente
- Soporta 12+ lenguajes
- Ignora `node_modules`, `dist`, `.git`
- Usa chunking `fixed` (mejor para código)
- Búsqueda semántica de implementaciones

**Lenguajes soportados:**
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

## 🏗️ Estructura de Archivos

```
sdk/examples/docs-rag/
├── .env.example          # Template de configuración
├── README.md            # Esta guía
├── verify-index.ts      # Verificar MongoDB setup
├── test-plugin.ts       # Test básico completo
├── ingest-pdf.ts        # Ejemplo PDF
├── ingest-docx.ts       # Ejemplo DOCX
├── ingest-html.ts       # Ejemplo HTML/Web
└── ingest-code.ts       # Ejemplo código fuente
```

## 📚 Documentación Adicional

- **Plugin README:** `plugins/rag/docs/README.md`
- **Setup Guide:** `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`
- **Troubleshooting:** `plugins/rag/docs/TROUBLESHOOTING.md`
- **Formatos soportados:** `plugins/rag/docs/SUPPORTED_FORMATS.md`
- **Quick Start:** `plugins/rag/docs/QUICKSTART.md`

## 🚀 Próximos Pasos

1. **Ejecuta verify-index.ts** para confirmar la configuración
2. **Ejecuta test-plugin.ts** para verificar que todo funciona
3. **Prueba los ejemplos** con tus propios documentos
4. **Integra en tu aplicación** usando estos ejemplos como referencia

## 💡 Consejos

- **Chunking Strategy:**
  - Usa `markdown` para docs estructurados
  - Usa `paragraph` para PDFs y HTML
  - Usa `fixed` para código fuente
  - Usa `sentence` para texto plano

- **Embedding Cache:**
  - Reduce costos de OpenAI API
  - Mejora performance
  - Ve estadísticas con `cacheHits`/`cacheMisses`

- **Persistent Storage:**
  - Los documentos se guardan en MongoDB
  - No necesitas re-ingerir después de reiniciar
  - Puedes actualizar o eliminar documentos individualmente

## ❓ Problemas Comunes

**Error: "vector search index not found"**
- Crea el índice vectorial en Atlas UI
- Sigue: `plugins/rag/docs/ATLAS_SETUP_GUIDE.md`

**Error: "MONGODB_URI is not set"**
- Crea el archivo `.env` en este directorio
- Copia desde `.env.example` y edita

**Error: "listSearchIndexes() not supported"**
- Requiere MongoDB Atlas M10+ tier
- Free tier (M0) NO soporta vector search

Ver más en: `plugins/rag/docs/TROUBLESHOOTING.md`
