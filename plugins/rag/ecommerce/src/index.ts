/**
 * E-commerce RAG Plugin for SnapAgent SDK
 * 
 * Provides sophisticated product search and recommendations using:
 * - Vector embeddings (Voyage AI)
 * - Attribute extraction (OpenAI)
 * - Soft rescoring with business metrics
 * - Optional reranking
 */

export { EcommerceRAGPlugin } from './EcommerceRAGPlugin';
export type {
  EcommerceRAGConfig,
  ProductDoc,
  QueryAttrs,
  URLSource,
  URLIngestResult,
} from './EcommerceRAGPlugin';


