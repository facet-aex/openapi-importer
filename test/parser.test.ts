import { describe, expect, it } from "vitest";

import { ImportError } from "../src/import-error.js";
import { parseOpenApiDocument, type ParseLimits } from "../src/parser.js";

const limits: ParseLimits = {
  maxDocumentBytes: 100_000,
  maxYamlAliases: 2,
  maxReferenceDepth: 16,
  maxReferenceCount: 10,
  maxOperationCount: 10,
};

describe("parseOpenApiDocument", () => {
  it("normalizes OpenAPI 3 operations into selectable candidates", () => {
    const result = parseOpenApiDocument(
      `openapi: 3.1.0
info:
  title: Weather API
  version: 1.0.0
paths:
  /forecast:
    get:
      operationId: getForecast
      summary: Read a forecast
      tags: [weather]
      responses:
        '200':
          description: OK
`,
      limits,
    );

    expect(result.document).toEqual({
      openapi: "3.1.0",
      title: "Weather API",
      version: "1.0.0",
    });
    expect(result.candidates).toEqual([
      {
        candidateId: "getForecast",
        jsonPointer: "#/paths/~1forecast/get",
        method: "GET",
        path: "/forecast",
        operationId: "getForecast",
        summary: "Read a forecast",
        tags: ["weather"],
      },
    ]);
  });

  it("escapes JSON Pointer path segments deterministically", () => {
    const result = parseOpenApiDocument(
      `openapi: 3.1.0
info: { title: Pointer, version: "1" }
paths:
  /a~b/c:
    post: {}
`,
      limits,
    );

    expect(result.candidates[0]?.jsonPointer).toBe("#/paths/~1a~0b~1c/post");
  });

  it("rejects unsupported Swagger 2 documents", () => {
    expect(() =>
      parseOpenApiDocument(
        '{"swagger":"2.0","info":{"title":"Old","version":"1"},"paths":{"/x":{"get":{}}}}',
        limits,
      ),
    ).toThrowError(ImportError);
  });

  it("counts remote references without resolving them in the synchronous parser", () => {
    const result = parseOpenApiDocument(
      '{"openapi":"3.0.3","info":{"title":"Remote","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"$ref":"https://example.com/response.json"}}}}}}',
      limits,
    );

    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("example.com/response.json");
  });
});
