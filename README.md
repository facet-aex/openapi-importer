# FACET OpenAPI Importer

Hostile-input OpenAPI 3.0.x/3.1.x ingestion and normalization service.

**Phase:** 1 — active.
**Runtime:** separate host process; no Docker requirement.
**Boundary:** Fetch/parse/normalize only. It cannot publish Facets, read provider execution secrets or reach private/local networks by policy.

Local process isolation is a demo boundary, not a production network-sandbox claim. This repository owns its limits, fetch policy, fixtures and security tests and must run from a standalone clone.
