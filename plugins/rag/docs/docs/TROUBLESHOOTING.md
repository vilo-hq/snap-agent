# MongoDB Atlas Vector Search - Troubleshooting

## Problemas Comunes y Soluciones

### 1. "Index not found" o "No results found"

**Síntomas:**
- `retrieveContext()` retorna 0 resultados
- Error: `index "docs_vector_index" not found`

**Causas y Soluciones:**

#### A. El índice no existe
```bash
# Verificar con el script
pnpm verify-index
```

**Solución:** Crear el índice siguiendo los pasos del README.

#### B. El índice está en status "Building"
- Ve a Atlas UI → Atlas Search
- Verifica que el status sea **"Active"** (no "Building" o "Initial Sync")
- Espera 2-5 minutos hasta que se complete

#### C. Nombre de índice incorrecto
```typescript
// Verifica que coincida con el nombre en Atlas
const plugin = new DocsRAGPlugin({
  vectorIndexName: 'docs_vector_index', // ⚠️ Debe coincidir exactamente
  // ...
});
```

#### D. No hay documentos ingeridos
```typescript
// Primero ingiere documentos
await plugin.ingest([docs], { agentId: 'test-agent' });

// Luego espera unos segundos para indexación
await new Promise(r => setTimeout(r, 2000));

// Ahora busca
await plugin.retrieveContext(query, { agentId: 'test-agent' });
```

---

### 2. "numDimensions mismatch"

**Error:**
```
Vector search error: embedding dimension mismatch
```

**Causa:** Las dimensiones del embedding no coinciden con el índice.

**Solución:**

| Modelo | Dimensiones |
|--------|-------------|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 |
| `voyage-3-lite` | 1024 |
| `voyage-3` | 1024 |

Actualiza el índice en Atlas:
```json
{
  "type": "vector",
  "path": "embedding",
  "numDimensions": 1536,  // ⚠️ Cambiar según tu modelo
  "similarity": "cosine"
}
```

---

### 3. "Free Tier / M0 not supported"

**Error:**
```
Vector Search is not available on free tier (M0/M2/M5)
```

**Causa:** Vector Search requiere Atlas M10 o superior.

**Solución:**
1. Upgradea tu cluster a **M10** o superior
2. En Atlas: Cluster → Edit Configuration → General → Cluster Tier → M10

**Costos aproximados (US East):**
- M10: ~$0.08/hora (~$57/mes)
- M20: ~$0.20/hora (~$144/mes)

**Alternativa para desarrollo:**
- Usar el free trial de Atlas (créditos gratis)
- Shared M10+ durante desarrollo, downgrade después

---

### 4. "Connection timeout" o "Network error"

**Síntomas:**
- `MongoServerError: connection timeout`
- `ECONNREFUSED` o `ETIMEDOUT`

**Soluciones:**

#### A. Whitelist IP
1. Ve a Atlas → Network Access → IP Access List
2. Click "Add IP Address"
3. Opciones:
   - Development: "Allow Access from Anywhere" (0.0.0.0/0)
   - Production: Solo tu IP específica

#### B. Connection String incorrecto
```typescript
// ✅ Correcto (con credenciales y database)
mongodb+srv://username:password@cluster.mongodb.net/mydb?retryWrites=true&w=majority

// ❌ Incorrecto
mongodb://localhost:27017 // No funciona con Atlas
```

#### C. Firewall corporativo
- Verifica que el puerto 27017 esté abierto
- Prueba con VPN o red diferente

---

### 5. "Embedding API rate limit"

**Error:**
```
OpenAI API error: 429 - Rate limit exceeded
```

**Solución:**

#### A. Habilita el cache
```typescript
const plugin = new DocsRAGPlugin({
  cache: {
    embeddings: {
      enabled: true,      // ✅ Reducir llamadas a API
      ttl: 3600000,       // 1 hora
      maxSize: 1000,
    },
  },
});
```

#### B. Batch ingestion con delay
```typescript
// Ingiere en lotes pequeños
const batchSize = 10;
for (let i = 0; i < docs.length; i += batchSize) {
  const batch = docs.slice(i, i + batchSize);
  await plugin.ingest(batch, { agentId: 'test' });
  
  // Delay entre batches
  if (i + batchSize < docs.length) {
    await new Promise(r => setTimeout(r, 1000));
  }
}
```

#### C. Upgrade OpenAI tier
- Tier 1: 500 requests/min
- Tier 2: 5,000 requests/min
- Tier 3+: Higher limits

---

### 6. Query retorna resultados irrelevantes

**Síntomas:**
- Los chunks retornados no son relevantes
- Score muy bajo (< 0.7)

**Soluciones:**

#### A. Ajusta minSimilarity
```typescript
const plugin = new DocsRAGPlugin({
  minSimilarity: 0.65,  // Bajar para más resultados (default: 0.7)
  limit: 10,            // Aumentar límite de resultados
});
```

#### B. Revisa la estrategia de chunking
```typescript
// Para docs técnicos
chunkingStrategy: 'markdown',  // ✅ Mejor para docs estructurados

// Para texto largo y sin estructura
chunkingStrategy: 'paragraph',

// Ajusta tamaño de chunks
maxChunkSize: 1500,  // Más grande = más contexto, menos precisión
```

#### C. Usa filtros
```typescript
await plugin.retrieveContext(query, {
  agentId: 'test',
  filters: {
    type: 'text',        // Solo chunks de texto (no código)
    section: 'API',      // Solo sección específica
  },
});
```

---

### 7. "Too many chunks" / Performance issues

**Síntomas:**
- Ingestion muy lenta
- Queries tardan mucho
- Muchos chunks en BD

**Soluciones:**

#### A. Aumenta chunk size
```typescript
const plugin = new DocsRAGPlugin({
  maxChunkSize: 2000,      // Aumentar de 1000 a 2000
  chunkOverlap: 100,       // Reducir overlap
});
```

#### B. Filtra contenido antes de ingerir
```typescript
// No ingerir todo el documento
const cleanContent = content
  .replace(/<!--[\s\S]*?-->/g, '')  // Remover comentarios HTML
  .replace(/^```[\s\S]*?```$/gm, '')  // Remover code blocks si no los necesitas
  .trim();
```

#### C. Usa agent-specific content
```typescript
// Contenido compartido (disponible para todos)
await plugin.ingest(sharedDocs, { agentId: 'shared' });

// Contenido específico del agente
await plugin.ingest(agentSpecificDocs, { agentId: 'sales-agent' });
```

---

### 8. "Duplicate documents" / Re-indexing

**Problema:** Al re-ingerir el mismo documento, se duplican los chunks.

**Solución:**

#### A. Usa update en vez de ingest
```typescript
// ❌ No hacer esto (duplica)
await plugin.ingest([doc], { agentId: 'test' });
await plugin.ingest([doc], { agentId: 'test' });  // Crea duplicados

// ✅ Hacer esto
await plugin.update(doc.id, doc, { agentId: 'test' });  // Reemplaza
```

#### B. Limpia antes de re-ingerir
```typescript
// Opción 1: Limpiar documento específico
await plugin.delete('doc-id', { agentId: 'test' });
await plugin.ingest([newDoc], { agentId: 'test' });

// Opción 2: Limpiar todo el agente
await plugin.clearAgent('test');
await plugin.ingest(allDocs, { agentId: 'test' });
```

---

## Scripts de Diagnóstico

### Verificar conexión y configuración
```bash
pnpm verify-index
```

### Test completo
```bash
pnpm test-plugin
```

### Inspeccionar documentos en MongoDB

```typescript
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

const coll = client.db('my_docs').collection('docs_content');

// Ver todos los chunks
const chunks = await coll.find({}).limit(10).toArray();
console.log(chunks);

// Contar por tipo
const byType = await coll.aggregate([
  { $group: { _id: '$metadata.type', count: { $sum: 1 } } }
]).toArray();
console.log(byType);
```

---

## Recursos Útiles

- [MongoDB Atlas Vector Search Docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/)
- [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings)
- [Atlas Search Index Syntax](https://www.mongodb.com/docs/atlas/atlas-search/create-index/)

---

## ¿Necesitas más ayuda?

1. Check [GitHub Issues](https://github.com/vilotech/snap-agent/issues)
2. Revisa los logs de MongoDB en Atlas UI → Metrics
3. Habilita debug logging en tu app
