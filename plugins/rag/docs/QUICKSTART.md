# 🚀 Setup Rápido - DocsRAGPlugin

## Instalación Inicial (Primera Vez)

### 1. Instala Dependencias

```bash
cd plugins/rag/docs
pnpm install
```

Esto instalará:
- ✅ `mongodb` - Cliente de MongoDB
- ✅ `openai` - Cliente de OpenAI para embeddings
- ✅ `tsx` - Para ejecutar TypeScript directamente
- ✅ `typescript`, `tsup` - Build tools

### 2. Configura Variables de Entorno

**📁 Ubicación:** El archivo `.env` debe estar en:
```
plugins/rag/docs/.env
```

> 📖 **Ver estructura completa:** [FILE_STRUCTURE.md](./docs/FILE_STRUCTURE.md)

Crea el archivo copiando el ejemplo:

```bash
cd plugins/rag/docs
cp .env.example .env
```

Edita `.env` con tus credenciales:

```env
# MongoDB Atlas
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=my_docs
MONGODB_COLLECTION=docs_content

# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Opcionales
TENANT_ID=my-company
AGENT_ID=test-agent
```

**¿Cómo obtener estas credenciales?**

#### MongoDB URI:
1. Ve a [MongoDB Atlas](https://cloud.mongodb.com)
2. Click en tu cluster → **"Connect"**
3. Selecciona **"Connect your application"**
4. Copia el connection string
5. Reemplaza `<password>` con tu contraseña real

#### OpenAI API Key:
1. Ve a [OpenAI Platform](https://platform.openai.com/api-keys)
2. Click **"+ Create new secret key"**
3. Copia la key (empieza con `sk-proj-`)

### 3. Crea el Vector Search Index en MongoDB

**Opción 1: Guía Visual Completa**
📘 Sigue paso a paso: [ATLAS_SETUP_GUIDE.md](./docs/ATLAS_SETUP_GUIDE.md)

**Opción 2: Pasos Rápidos**

1. Ve a [MongoDB Atlas](https://cloud.mongodb.com)
2. Tu Cluster → **"Atlas Search"** (menú izquierdo)
3. Click **"Create Search Index"**
4. Selecciona **"Atlas Vector Search"**
5. Configuración:
   - Method: **JSON Editor**
   - Index Name: `docs_vector_index`
   - Database: `my_docs`
   - Collection: `docs_content`
6. Pega este JSON:

```json
{
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
      "path": "agentId"
    },
    {
      "type": "filter",
      "path": "metadata.type"
    },
    {
      "type": "filter",
      "path": "metadata.section"
    }
  ]
}
```

7. Click **"Create Search Index"**
8. Espera a que el status sea **"Active"** (1-3 minutos)

### 4. Verifica que Todo Funciona

```bash
cd ../../../sdk/examples/docs-rag
npx tsx verify-index.ts
```

Salida esperada:
```
✅ Conectado a MongoDB
✅ Colección "docs_content" existe
✅ Índice "docs_vector_index" encontrado!
   📊 Estado: Active
```

Si ves errores, consulta [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)

### 5. Prueba el Plugin

```bash
cd ../../../sdk/examples/docs-rag
npx tsx test-plugin.ts
```

Esto:
1. Ingiere un documento de prueba
2. Realiza búsquedas semánticas
3. Muestra estadísticas
4. Verifica la persistencia

Salida esperada:
```
✅ Documento ingerido: 1 documento(s)

🔍 Query: "How do I authenticate?"
   📊 Resultados: 2
   📈 Score promedio: 0.847

✅ Prueba completada exitosamente!
```

---

## Scripts Disponibles

| Comando | Descripción | Ubicación |
|---------|-------------|----------|
| `pnpm build` | Compila el plugin a dist/ | `plugins/rag/docs/` |
| `pnpm dev` | Compila en modo watch | `plugins/rag/docs/` |
| `pnpm test` | Ejecuta tests unitarios | `plugins/rag/docs/` |
| `npx tsx verify-index.ts` | Verifica MongoDB | `sdk/examples/docs-rag/` |
| `npx tsx test-plugin.ts` | Prueba completa del plugin | `sdk/examples/docs-rag/` |

---

## Uso en tu Aplicación

Una vez configurado, úsalo así:

```typescript
import { DocsRAGPlugin } from '@snap-agent/rag-docs';
import { createClient, MemoryStorage } from '@snap-agent/core';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Docs Assistant',
  instructions: 'Help users find information in documentation.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new DocsRAGPlugin({
      // MongoDB
      mongoUri: process.env.MONGODB_URI!,
      dbName: 'my_docs',
      tenantId: 'my-company',
      
      // Embeddings
      embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
      chunkingStrategy: 'markdown',
      
      // Cache (opcional pero recomendado)
      cache: {
        embeddings: {
          enabled: true,
          ttl: 3600000,
          maxSize: 1000,
        },
      },
    }),
  ],
});

// Ingiere documentos
await agent.ingestDocuments([
  {
    id: 'getting-started',
    content: '# Getting Started\n\n...',
    metadata: { title: 'Getting Started' },
  },
]);

// Haz preguntas
const response = await client.chat({
  threadId: thread.id,
  message: 'How do I get started?',
  useRAG: true,
});

console.log(response.text);
```

---

## ⚠️ Requisitos

### MongoDB Atlas Tier
- ❌ **M0/M2/M5** (Free) - NO soportan Vector Search
- ✅ **M10+** - Requerido (~$0.08/hora)

Para upgradear: Atlas → Cluster → Edit Configuration → M10

### Node.js
- Versión 18+ recomendada

### Whitelist IP
Para conectarte a Atlas desde tu máquina:
1. Atlas → **Network Access**
2. **Add IP Address**
3. Development: "Allow Access from Anywhere" (0.0.0.0/0)

---

## 📚 Más Recursos

- 📘 [ATLAS_SETUP_GUIDE.md](./docs/ATLAS_SETUP_GUIDE.md) - Guía visual detallada
- 🔧 [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) - Soluciones a problemas comunes
- 📖 [README.md](./README.md) - Documentación completa de API

---

## 🆘 ¿Problemas?

### "tsx no se reconoce como comando"
```bash
# Asegúrate de instalar dependencias primero
pnpm install
```

### "Cannot find module '@snap-agent/core'"
```bash
# Instala las peer dependencies
cd ../../../  # Ir a la raíz del workspace
pnpm install
```

### "MongoServerError: connection timeout"
- Verifica que tu IP esté en whitelist (Network Access en Atlas)
- Verifica que el MONGODB_URI sea correcto

### Más ayuda
Ver [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
