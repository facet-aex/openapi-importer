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
      expect.objectContaining({
        candidateId: "getForecast",
        jsonPointer: "#/paths/~1forecast/get",
        method: "GET",
        path: "/forecast",
        operationId: "getForecast",
        summary: "Read a forecast",
        tags: ["weather"],
        normalized: expect.any(Object),
        warnings: expect.any(Array),
      }),
    ]);
  });

  it("normalizes parameters, JSON body, responses, servers, and supported auth", () => {
    const result = parseOpenApiDocument(
      `openapi: 3.0.3
info: { title: Weather, version: "1" }
servers:
  - url: https://{region}.api.example.com/v1
    description: Regional API
    variables:
      region: { default: us }
components:
  securitySchemes:
    ApiKey:
      type: apiKey
      in: header
      name: X-API-Key
    BearerAuth:
      type: http
      scheme: bearer
security:
  - ApiKey: []
  - BearerAuth: []
paths:
  /weather/{id}:
    parameters:
      - in: path
        name: id
        required: true
        schema: { type: string }
      - in: query
        name: locale
        schema: { type: string }
    get:
      operationId: getWeather
      parameters:
        - in: query
          name: locale
          required: true
          schema: { type: string, enum: [en, vi] }
        - in: header
          name: X-Trace
          schema: { type: string, nullable: true, example: SHOULD_NOT_PERSIST }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                units:
                  type: string
                  default: SHOULD_NOT_PERSIST
                  x-secret-example: SHOULD_NOT_PERSIST
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { type: number }
        '400':
          description: Bad request
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
`,
      limits,
    );

    expect(result.candidates[0]).toMatchObject({
      normalized: {
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            query: {
              type: "object",
              additionalProperties: false,
              properties: {
                locale: { type: "string", enum: ["en", "vi"] },
              },
              required: ["locale"],
            },
            header: {
              type: "object",
              additionalProperties: false,
              properties: {
                "X-Trace": {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
              },
            },
            body: {
              type: "object",
              properties: { units: { type: "string" } },
            },
          },
          required: ["path", "query", "body"],
        },
        outputSchema: { type: "array", items: { type: "number" } },
        errorSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
        servers: [
          {
            url: "https://{region}.api.example.com/v1",
            description: "Regional API",
            variables: { region: "us" },
          },
        ],
        authAlternatives: [
          {
            schemes: [
              {
                schemeName: "ApiKey",
                kind: "API_KEY_HEADER",
                parameterName: "X-API-Key",
              },
            ],
          },
          {
            schemes: [{ schemeName: "BearerAuth", kind: "BEARER" }],
          },
        ],
        responseMetadata: {
          successStatusCode: "200",
          successMediaType: "application/json",
          errorStatusCodes: ["400"],
        },
      },
      warnings: [],
    });
    expect(JSON.stringify(result.candidates[0])).not.toContain(
      "SHOULD_NOT_PERSIST",
    );
  });

  it("preserves security alternatives and warns on unsupported schemes or missing schemas", () => {
    const result = parseOpenApiDocument(
      `openapi: 3.1.0
info: { title: Auth, version: "1" }
servers:
  - url: https://root.example
components:
  securitySchemes:
    ApiKey: { type: apiKey, in: query, name: key }
    BearerAuth: { type: http, scheme: bearer }
    OAuth: { type: oauth2, flows: {} }
paths:
  /status:
    servers:
      - url: https://path.example
    get:
      servers:
        - url: https://operation.example
      security:
        - ApiKey: []
          BearerAuth: []
        - {}
        - OAuth: []
      responses:
        '204': { description: Empty }
`,
      limits,
    );

    expect(result.candidates[0]).toMatchObject({
      normalized: {
        servers: [{ url: "https://operation.example", variables: {} }],
        authAlternatives: [
          {
            schemes: [
              {
                schemeName: "ApiKey",
                kind: "API_KEY_QUERY",
                parameterName: "key",
              },
              { schemeName: "BearerAuth", kind: "BEARER" },
            ],
          },
          { schemes: [] },
          {
            schemes: [
              {
                schemeName: "OAuth",
                kind: "UNSUPPORTED",
                sourceType: "oauth2",
              },
            ],
          },
        ],
        outputSchema: {},
        errorSchema: {},
        responseMetadata: {
          successStatusCode: "204",
          errorStatusCodes: [],
        },
      },
      warnings: [
        expect.objectContaining({ code: "MISSING_SUCCESS_RESPONSE_SCHEMA" }),
        expect.objectContaining({ code: "UNSUPPORTED_AUTH_SCHEME" }),
      ],
    });
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
