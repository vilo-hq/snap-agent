# 📸 Guía Visual: Crear Vector Search Index en Atlas

Esta guía te muestra **exactamente** cómo se ve cada paso en la interfaz de MongoDB Atlas.

---

## 🎯 Objetivo

Crear un índice llamado `docs_vector_index` en la colección `docs_content` para búsqueda vectorial.

---

## 📋 Pasos Detallados

### **1. Inicia sesión en MongoDB Atlas**

Ve a: https://cloud.mongodb.com

- Usuario y contraseña
- O SSO si tu empresa lo usa

---

### **2. Selecciona tu Proyecto**

En el dropdown superior, selecciona tu proyecto (ej: "Production", "Development", etc.)

---

### **3. Encuentra el Tab "Atlas Search"**

En el menú lateral izquierdo, busca:

```
📊 Overview
🗄️ Database (Collections)
🔍 Atlas Search          ← AQUÍ
📈 Metrics
⚙️ Configuration
```

Haz clic en **"Atlas Search"**

---

### **4. Create Search Index**

Verás un botón verde grande: **"Create Search Index"**

Haz clic aquí.

---

### **5. Selecciona "Atlas Vector Search"**

Aparecerán 2 opciones:

```
┌─────────────────────────────┐
│  Atlas Search               │
│  Full-text search indexes   │
└─────────────────────────────┘

┌─────────────────────────────┐
│  Atlas Vector Search   ✅   │  ← SELECCIONA ESTE
│  Semantic search with       │
│  vector embeddings          │
└─────────────────────────────┘
```

Clic en **"Next"**

---

### **6. Configuración del Índice**

#### Paso 6.1: Configuration Method

Verás 2 opciones:

```
○ Visual Editor
● JSON Editor  ← SELECCIONA ESTE
```

Selecciona **"JSON Editor"** para pegar la configuración completa.

#### Paso 6.2: Database and Collection

```
Database: [my_docs        ▼]
Collection: [docs_content ▼]
```

Selecciona tu database y collection.

> **Nota:** Si la colección no existe, créala primero:
> - Ve a "Collections" → "Create Database"
> - Database: `my_docs`
> - Collection: `docs_content`

#### Paso 6.3: Index Name

```
Index Name: docs_vector_index
```

**⚠️ IMPORTANTE:** El nombre debe ser exactamente `docs_vector_index` (o el que configuraste en tu plugin).

#### Paso 6.4: Index Definition (JSON)

En el editor JSON grande, pega esto:

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

**⚠️ Si usas `text-embedding-3-large`:**
Cambia `"numDimensions": 1536` a `"numDimensions": 3072`

---

### **7. Review and Create**

Verás un resumen:

```
═══════════════════════════════════
Index Configuration Summary
═══════════════════════════════════
Name: docs_vector_index
Database: my_docs
Collection: docs_content

Vector Field: embedding (1536 dimensions)
Filter Fields: 
  - tenantId
  - agentId
  - metadata.type
  - metadata.section
═══════════════════════════════════
```

Haz clic en **"Create Search Index"**

---

### **8. Espera la Construcción**

Verás un indicador de progreso:

```
docs_vector_index
━━━━━━━━━━━━━━━━━━━━━━ 45%
Status: Building...
```

Esto puede tardar **1-5 minutos** dependiendo del tamaño.

Cuando esté listo:

```
docs_vector_index
████████████████████████ ✅
Status: Active
```

---

### **9. Verificación Final**

En la lista de índices deberías ver:

```
┌────────────────────────────────────────────────────────┐
│ Name                  | Database | Collection | Status │
├────────────────────────────────────────────────────────┤
│ docs_vector_index     | my_docs  | docs_content | ✅   │
└────────────────────────────────────────────────────────┘
```

---

## ✅ Checklist de Verificación

Antes de continuar, verifica:

- [ ] El nombre del índice es exactamente `docs_vector_index`
- [ ] El status es **"Active"** (no "Building")
- [ ] Database: `my_docs` (o tu db)
- [ ] Collection: `docs_content`
- [ ] `numDimensions` coincide con tu modelo de embedding:
  - `text-embedding-3-small`: 1536 ✅
  - `text-embedding-3-large`: 3072
  - `voyage-3-lite`: 1024

---

## 🧪 Probar el Índice

### Opción 1: Script de Verificación

```bash
cd plugins/rag/docs
export MONGODB_URI="tu-connection-string"
pnpm verify-index
```

Salida esperada:
```
✅ Conectado a MongoDB
✅ Colección "docs_content" existe
✅ Índice "docs_vector_index" encontrado!
   📊 Estado: Active
```

### Opción 2: Prueba Completa

```bash
export MONGODB_URI="mongodb+srv://..."
export OPENAI_API_KEY="sk-..."
pnpm test-plugin
```

Salida esperada:
```
✅ Documento ingerido: 1 documento(s)
🔍 Query: "How do I authenticate?"
   📊 Resultados: 2
   📈 Score promedio: 0.847
```

---

## 🆘 Problemas Comunes

### "Index not found"
- Verifica que el nombre sea exactamente `docs_vector_index`
- Espera a que el status sea "Active"

### "M0/M2/M5 not supported"
- Vector Search requiere **M10 o superior**
- Upgradea tu cluster en: Cluster → Edit Configuration → M10

### "No results found"
- Primero ingiere documentos: `await plugin.ingest([docs], { agentId: 'test' })`
- Espera 2-3 segundos después de ingerir

---

## 📚 Más Información

- Ver [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) para más soluciones
- [MongoDB Vector Search Docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/)
