# Vector Databases

A vector database stores embeddings and supports similarity search.

## Indexing strategies

- HNSW builds a navigable small-world graph
- IVF partitions the space into cells

## Example query

```sql
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 5;
```

Cosine distance is appropriate for normalised vectors.
