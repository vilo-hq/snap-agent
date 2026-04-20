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

### 3. Persistencia de Agentes (End-to-End)

Verifica que DocsRAGPlugin implementa correctamente `getConfig()` para la persistencia:

```bash
cd sdk/examples/docs-rag
npx tsx agent-persistence.ts
```

**Este ejemplo verifica:**
- ✅ DocsRAGPlugin tiene método `getConfig()`
- ✅ La configuración es serializable a JSON
- ✅ Valores sensibles usan referencias a env vars (ej: `${MONGODB_URI}`)
- ✅ PluginRegistry puede re-instanciar el plugin desde config guardada
- ✅ El plugin funciona correctamente con un agente
- ✅ La configuración se guarda en MongoDB

**Proceso de verificación:**
1. Crea una instancia de `DocsRAGPlugin`
2. Llama a `getConfig()` para obtener la configuración serializable
3. Verifica que valores sensibles usan referencias a env vars
4. Registra el plugin en `PluginRegistry`
5. Simula re-instanciación desde config guardada
6. Crea un agente con el plugin
7. Verifica que el plugin funciona (ingest y search)

**Qué demuestra esto:**
Cuando recargues un agente desde MongoDB, el SDK:
1. Lee el array `pluginConfigs` de la base de datos
2. Para cada config, llama `pluginRegistry.instantiate(config)`
3. El registry resuelve las env vars (ej: `${MONGODB_URI}` → URI real)
4. Llama a la factory function con la config resuelta
5. La factory crea una nueva instancia del plugin
6. El agente recargado funciona con los plugins re-instanciados

> 💡 Este ejemplo prueba que el bug de persistencia está **resuelto** para DocsRAGPlugin, EcommerceRAGPlugin y SupportRAGPlugin (todos tienen `getConfig()`).

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
├── agent-persistence.ts # ⭐ Flujo completo de persistencia (E2E)
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
