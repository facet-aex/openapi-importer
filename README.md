# FACET OpenAPI Importer (`@facet/openapi-importer`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/SECURITY-OPENAPI%20INGESTION-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Isolated OpenAPI 3.0 and 3.1 ingestion, `$ref` bundling, and operation normalization service for FACET.

## Overview

`openapi-importer` is a dedicated parsing and normalization microservice for **FACET**. It accepts untrusted OpenAPI URLs or uploaded YAML/JSON specifications and returns bounded, normalized operation schemas for `control-api`.

## Role in FACET

- **Process Isolation:** Keeps external specification fetching and recursive schema parsing separate from the main control-plane database and provider credentials.
- **Network & Size Hardening:** Enforces strict HTTPS, DNS/IP, redirect, compression, byte-budget, and timeout limits when fetching remote specs and external `$ref` graphs.
- **Schema Normalization:** Resolves parameter, request-body, response, and security schemes into candidate JSON Schemas while stripping unsafe defaults, examples, and extensions.
- **Authoring Diagnostics:** Emits deterministic JSON Pointers and per-operation warnings for review before an `API` Facet is published.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime & HTTP | Node.js 24 (ESM), TypeScript, Fastify 5 |
| Parsing & Validation | `@apidevtools/json-schema-ref-parser`, `yaml`, Zod |
| Testing & Container | Vitest, ESLint, Docker (`node:24-alpine`) |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche.
