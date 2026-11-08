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
        method: "GET",
        path: "/forecast",
        operationId: "getForecast",
        summary: "Read a forecast",
        tags: ["weather"],
      },
    ]);
  });

  it("rejects unsupported Swagger 2 documents", () => {
    expect(() =>
      parseOpenApiDocument(
        '{"swagger":"2.0","info":{"title":"Old","version":"1"},"paths":{"/x":{"get":{}}}}',
        limits,
      ),
    ).toThrowError(ImportError);
  });

  it("does not fetch remote references during parse", () => {
    const result = parseOpenApiDocument(
      '{"openapi":"3.0.3","info":{"title":"Remote","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"$ref":"https://example.com/response.json"}}}}}}',
      limits,
    );

    expect(result.warnings).toEqual([
      {
        code: "REMOTE_REFERENCE_NOT_RESOLVED",
        message: "A remote reference was recorded but not fetched.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("example.com/response.json");
  });
});
