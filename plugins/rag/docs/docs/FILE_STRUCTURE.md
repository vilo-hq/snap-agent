# 📁 Estructura de Archivos - DocsRAGPlugin

## Ubicación del archivo .env

El archivo `.env` **DEBE** estar en la raíz del plugin:

```
snap-agent/
└── plugins/
    └── rag/
        └── docs/                    ← raíz del plugin
            ├── .env                 ✅ AQUÍ va el .env
            ├── .env.example         
            ├── package.json
            ├── README.md
            ├── QUICKSTART.md
            ├── tsconfig.json
            │
            ├── src/
            │   ├── index.ts
            │   └── DocsRAGPlugin.ts
            │
            ├── scripts/
            │   └── verify-index.ts   ← carga ../env
            │
            ├── examples/
            │   └── test-docs-rag.ts  ← carga ../env
            │
            ├── tests/
            │   └── DocsRAGPlugin.test.ts
            │
            └── docs/
                ├── ATLAS_SETUP_GUIDE.md
                └── TROUBLESHOOTING.md
```

## ❌ Ubicaciones INCORRECTAS

```
plugins/rag/docs/src/.env           ❌ NO
plugins/rag/docs/scripts/.env       ❌ NO
plugins/rag/docs/examples/.env      ❌ NO
plugins/rag/.env                    ❌ NO
snap-agent/.env                     ❌ NO
```

## ✅ Cómo Crear el .env

### Opción 1: Copiar el ejemplo

```bash
cd plugins/rag/docs
cp .env.example .env
```

### Opción 2: Crear manualmente

**Ubicación:** `plugins/rag/docs/.env`

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

## 🔍 Verificar que el .env está en el lugar correcto

Desde el directorio raíz del workspace:

```bash
# Ver si existe
ls -la plugins/rag/docs/.env

# O en Windows
dir plugins\rag\docs\.env
```

Si existe, verás:
```
-rw-r--r--  1 user  staff  245 Apr 17 10:30 .env
```

## 🧪 Probar que Funciona

Los scripts cargan automáticamente el .env:

```bash
cd plugins/rag/docs
pnpm verify-index
```

Si el .env está bien configurado, verás:
```
✅ Conectado a MongoDB
```

Si NO encuentra el .env o las variables, verás:
```
❌ Error: MONGODB_URI no está configurado

📁 Crea el archivo .env en: plugins/rag/docs/.env
```

## 🔐 Seguridad

El archivo `.env` ya está en `.gitignore` por defecto:

```gitignore
# .gitignore
.env
.env.local
.env.*.local
```

**⚠️ NUNCA** hagas commit de tu `.env` con credenciales reales.

## 📚 Más Información

- [QUICKSTART.md](../QUICKSTART.md) - Setup completo
- [.env.example](../.env.example) - Plantilla de ejemplo
