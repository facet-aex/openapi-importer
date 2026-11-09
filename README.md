# FACET OpenAPI Importer

Hostile-input OpenAPI 3.0.x/3.1.x ingestion and normalization service.

**Phase:** 1 — active.
**Runtime:** separate host process; no Docker requirement.
**Boundary:** Fetch/parse/normalize only. It cannot publish Facets, read provider execution secrets or reach private/local networks by policy.

Local process isolation is a demo boundary, not a production network-sandbox claim. This standalone npm repository owns its `package-lock.json`, limits, fetch policy, fixtures and security tests.

## Local setup

```bash
cp .env.example .env
npm ci
npm run dev
```

`POST /v1/imports/parse` accepts pasted/uploaded content or an HTTPS URL and returns normalized operation candidates, stable JSON Pointers, source provenance (`sha256`, byte count and URL fetch metadata), and the bounded source snapshot for the trusted Control API worker. The snapshot is an internal response field and must never be exposed by public APIs or logged. URL requests validate credentials, ports, hostnames and every IPv4/IPv6 DNS answer, pin the checked address, revalidate every redirect, reject compression, and enforce one total timeout and byte budget.

The caller may pass the import job's complete `limits` snapshot. Requested values may only tighten the configured deployment maxima; attempts to loosen them fail with `IMPORT_LIMIT_EXCEEDS_POLICY`.

External `$ref` graphs are bundled for validation with `@apidevtools/json-schema-ref-parser` 16.0.6. Its built-in filesystem and HTTP resolvers are disabled. Every remote document must pass FACET's HTTPS/DNS/IP/redirect policy, all documents share one byte budget and deadline, reference count/depth are bounded, and paste/upload sources reject relative external references because they have no retrieval base. The bundled graph is currently validation-only and is not returned or exposed publicly.

`npm audit` currently reports moderate findings only in the development `typescript-eslint → minimatch` toolchain, not in the importer runtime dependency path. Do not run `npm audit fix --force`; reassess and upgrade the lint toolchain separately.

The local process boundary is not a production network sandbox. Before public deployment, run this service behind an explicit egress policy. Remote `$ref` resolution remains disabled; references are recorded as warnings until the shared fetch budget and provenance model are implemented. Run `npm run verify` before committing.
