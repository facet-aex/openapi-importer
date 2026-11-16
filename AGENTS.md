# `openapi-importer` instructions

**Owner:** Antigravity  
**Port:** `4010`  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0015-actorbazaar-docker-and-a2a-mvp.md`

## Role

Isolated OpenAPI 3.0/3.1 ingestion, remote `$ref` bundling, and operation normalization worker/service used by `control-api` for `EXTERNAL_HTTP_API` Facets. Preserves all SSRF, DNS/IP pinning, byte/depth/alias budgets, and schema normalization invariants.
