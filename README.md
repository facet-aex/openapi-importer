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

`POST /v1/imports/parse` accepts pasted content or file content supplied by the caller and returns normalized operation candidates. The URL network-policy layer validates HTTPS, credentials, ports, hostnames and every IPv4/IPv6 DNS answer; transport, redirect handling and remote `$ref` resolution remain disabled until the isolated fetcher is complete. Run `npm run verify` before committing.
