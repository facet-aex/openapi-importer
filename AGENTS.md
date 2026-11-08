# openapi-importer instructions

- This is a standalone repository. It must install, build and run without parent/sibling configuration or source imports.
- Treat every URL, redirect, DNS answer, YAML alias, `$ref`, extension and example as hostile.
- Implement upload and paste even when URL import exists.
- Apply IPv4/IPv6, DNS rebinding, redirect, byte, time, alias, reference-depth/count and operation-count limits.
- Disable ambient proxies and do not receive control-plane/provider/payment secrets.
- Produce normalized candidates and warnings; publication remains a control-api decision.
- Exchange work/results through versioned contracts and authenticated service APIs, never a shared source tree.
- Never weaken production validation by adding generic localhost allowlists for tests.
