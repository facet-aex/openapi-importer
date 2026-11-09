import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ImporterConfig } from "../src/config.js";

const config: ImporterConfig = {
  NODE_ENV: "test",
  FACET_ENV: "local",
  HOST: "127.0.0.1",
  PORT: 4010,
  IMPORTER_MAX_DOCUMENT_BYTES: 100_000,
  IMPORTER_MAX_YAML_ALIASES: 20,
  IMPORTER_MAX_REDIRECTS: 3,
  IMPORTER_MAX_REFERENCE_DEPTH: 16,
  IMPORTER_MAX_REFERENCE_COUNT: 256,
  IMPORTER_MAX_OPERATION_COUNT: 500,
  IMPORTER_TIMEOUT_MS: 10_000,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("import parse route", () => {
  it("fetches a URL through the isolated fetch dependency and returns provenance", async () => {
    app = buildApp(config, {
      fetchRemote: async () => ({
        content: `openapi: 3.1.0
info: { title: Demo, version: 1.0.0 }
paths:
  /status:
    get:
      operationId: getStatus
      responses:
        "200": { description: OK }
`,
        mediaType: "application/yaml",
        byteLength: 164,
        finalUrl: "https://api.example.com/openapi.yaml",
        redirectCount: 1,
        sha256: "a".repeat(64),
      }),
    });

    const result = await app.inject({
      method: "POST",
      url: "/v1/imports/parse",
      payload: {
        source: { kind: "url", url: "https://source.example/spec" },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      document: { openapi: "3.1.0", title: "Demo" },
      candidates: [{ operationId: "getStatus", method: "GET" }],
      source: {
        kind: "url",
        sha256: "a".repeat(64),
        byteLength: 164,
        finalUrl: "https://api.example.com/openapi.yaml",
        redirectCount: 1,
      },
    });
  });

  it("hashes pasted content without fetching", async () => {
    app = buildApp(config);
    const content =
      '{"openapi":"3.0.3","info":{"title":"Paste","version":"1"},"paths":{"/x":{"get":{}}}}';
    const result = await app.inject({
      method: "POST",
      url: "/v1/imports/parse",
      payload: { source: { kind: "paste", content } },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json().source).toMatchObject({
      kind: "paste",
      byteLength: Buffer.byteLength(content),
    });
    expect(result.json().source.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
