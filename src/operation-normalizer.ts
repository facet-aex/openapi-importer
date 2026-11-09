type JsonObject = Record<string, unknown>;
type JsonSchema = boolean | JsonObject;

export interface OperationWarning {
  code: string;
  message: string;
}

export interface NormalizedOperation {
  description?: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errorSchema: JsonSchema;
  servers: Array<{
    url: string;
    description?: string;
    variables: Record<string, string>;
  }>;
  authAlternatives: Array<{
    schemes: Array<{
      schemeName: string;
      kind: "API_KEY_HEADER" | "API_KEY_QUERY" | "BEARER" | "UNSUPPORTED";
      parameterName?: string;
      sourceType?: string;
    }>;
  }>;
  responseMetadata: {
    successStatusCode?: string;
    successMediaType?: string;
    errorStatusCodes: string[];
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

const omittedSchemaKeywords = new Set(["example", "examples", "default"]);

function normalizeSchema(value: unknown): JsonSchema {
  if (typeof value === "boolean") return value;
  if (!isObject(value)) return {};

  const nullable = value.nullable === true;
  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "nullable" || omittedSchemaKeywords.has(key)) continue;
    if (Array.isArray(child)) {
      normalized[key] = child.map((item) =>
        isObject(item) || Array.isArray(item) ? normalizeNested(item) : item,
      );
    } else if (isObject(child)) {
      normalized[key] = normalizeNested(child);
    } else {
      normalized[key] = child;
    }
  }
  return nullable ? { anyOf: [normalized, { type: "null" }] } : normalized;
}

function normalizeNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNested);
  if (!isObject(value)) return value;
  return normalizeSchema(value);
}

function readContentSchema(content: unknown): {
  mediaType?: string;
  schema?: JsonSchema;
} {
  if (!isObject(content)) return {};
  const entries = Object.entries(content).filter(([, media]) =>
    isObject(media),
  );
  const selected =
    entries.find(
      ([mediaType]) => mediaType.toLowerCase() === "application/json",
    ) ??
    entries.find(([mediaType]) => /\+json$/iu.test(mediaType)) ??
    entries[0];
  if (!selected) return {};
  const [mediaType, media] = selected as [string, JsonObject];
  if (!("schema" in media)) return { mediaType };
  return { mediaType, schema: normalizeSchema(media.schema) };
}

const parameterLocations = ["path", "query", "header", "cookie"] as const;

function normalizeInput(
  pathItem: JsonObject,
  operation: JsonObject,
  warnings: OperationWarning[],
): JsonSchema {
  const merged = new Map<string, JsonObject>();
  for (const parameters of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(parameters)) continue;
    for (const parameter of parameters) {
      if (!isObject(parameter)) continue;
      if (typeof parameter.$ref === "string") {
        warnings.push({
          code: "UNRESOLVED_PARAMETER_REFERENCE",
          message:
            "A referenced parameter requires schema-closure normalization.",
        });
        continue;
      }
      const location = readString(parameter.in);
      const name = readString(parameter.name);
      if (!location || !name) continue;
      merged.set(`${location}\u0000${name}`, parameter);
    }
  }

  const properties: JsonObject = {};
  const requiredNamespaces: string[] = [];
  for (const location of parameterLocations) {
    const namespaceProperties: JsonObject = {};
    const required: string[] = [];
    for (const parameter of merged.values()) {
      if (parameter.in !== location) continue;
      const name = readString(parameter.name);
      if (!name) continue;
      const contentSchema = readContentSchema(parameter.content).schema;
      namespaceProperties[name] =
        contentSchema ?? normalizeSchema(parameter.schema);
      if (location === "path" || parameter.required === true)
        required.push(name);
    }
    if (Object.keys(namespaceProperties).length === 0) continue;
    properties[location] = {
      type: "object",
      additionalProperties: false,
      properties: namespaceProperties,
      ...(required.length > 0 ? { required } : {}),
    };
    if (required.length > 0) requiredNamespaces.push(location);
  }

  if (isObject(operation.requestBody)) {
    if (typeof operation.requestBody.$ref === "string") {
      warnings.push({
        code: "UNRESOLVED_REQUEST_BODY_REFERENCE",
        message:
          "A referenced request body requires schema-closure normalization.",
      });
    } else {
      const body = readContentSchema(operation.requestBody.content);
      if (body.schema !== undefined) {
        properties.body = body.schema;
        if (operation.requestBody.required === true)
          requiredNamespaces.push("body");
      } else {
        warnings.push({
          code: "MISSING_REQUEST_BODY_SCHEMA",
          message: "The request body does not define a supported schema.",
        });
      }
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(requiredNamespaces.length > 0 ? { required: requiredNamespaces } : {}),
  };
}

function statusRank(status: string): number {
  if (/^\d{3}$/u.test(status)) return Number(status);
  if (/^[1-5]XX$/iu.test(status)) return Number(status[0]) * 100 + 99;
  return 9999;
}

function normalizeResponses(
  operation: JsonObject,
  warnings: OperationWarning[],
): {
  outputSchema: JsonSchema;
  errorSchema: JsonSchema;
  metadata: NormalizedOperation["responseMetadata"];
} {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const entries = Object.entries(responses).filter(([, response]) =>
    isObject(response),
  );
  const success = entries
    .filter(([status]) => /^2(?:\d{2}|XX)$/iu.test(status))
    .sort(([left], [right]) => statusRank(left) - statusRank(right))[0];
  let outputSchema: JsonSchema = {};
  let successMediaType: string | undefined;
  if (success) {
    const response = success[1] as JsonObject;
    if (typeof response.$ref !== "string") {
      const selected = readContentSchema(response.content);
      outputSchema = selected.schema ?? {};
      successMediaType = selected.mediaType;
    }
  }
  if (!success || Object.keys(outputSchema).length === 0) {
    warnings.push({
      code: "MISSING_SUCCESS_RESPONSE_SCHEMA",
      message:
        "The operation does not define a supported success response schema.",
    });
  }

  const errors = entries
    .filter(([status]) => /^(?:[45](?:\d{2}|XX)|default)$/iu.test(status))
    .sort(([left], [right]) => statusRank(left) - statusRank(right));
  const errorSchemas = errors.flatMap(([, response]) => {
    if (typeof (response as JsonObject).$ref === "string") return [];
    const schema = readContentSchema((response as JsonObject).content).schema;
    return schema === undefined ? [] : [schema];
  });
  const errorSchema: JsonSchema =
    errorSchemas.length === 0
      ? {}
      : errorSchemas.length === 1
        ? errorSchemas[0]!
        : { oneOf: errorSchemas };

  return {
    outputSchema,
    errorSchema,
    metadata: {
      ...(success ? { successStatusCode: success[0] } : {}),
      ...(successMediaType ? { successMediaType } : {}),
      errorStatusCodes: errors.map(([status]) => status),
    },
  };
}

function normalizeServers(
  document: JsonObject,
  pathItem: JsonObject,
  operation: JsonObject,
  warnings: OperationWarning[],
): NormalizedOperation["servers"] {
  const selected = [operation.servers, pathItem.servers, document.servers].find(
    (value) => Array.isArray(value) && value.length > 0,
  );
  if (!Array.isArray(selected)) return [];
  return selected.flatMap((server) => {
    if (!isObject(server)) return [];
    const url = readString(server.url);
    if (!url) return [];
    const variables: Record<string, string> = {};
    if (isObject(server.variables)) {
      for (const [name, variable] of Object.entries(server.variables)) {
        if (!isObject(variable) || typeof variable.default !== "string") {
          warnings.push({
            code: "SERVER_VARIABLE_DEFAULT_MISSING",
            message: `Server variable ${name} has no string default.`,
          });
          continue;
        }
        variables[name] = variable.default;
      }
    }
    const description = readString(server.description);
    return [
      {
        url,
        ...(description ? { description } : {}),
        variables,
      },
    ];
  });
}

function normalizeAuth(
  document: JsonObject,
  operation: JsonObject,
  warnings: OperationWarning[],
): NormalizedOperation["authAlternatives"] {
  const security = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(document.security)
      ? document.security
      : [];
  const components = isObject(document.components) ? document.components : {};
  const definitions = isObject(components.securitySchemes)
    ? components.securitySchemes
    : {};

  return security.flatMap((requirement) => {
    if (!isObject(requirement)) return [];
    return [
      {
        schemes: Object.keys(requirement).map((schemeName) => {
          const definition = definitions[schemeName];
          const sourceType = isObject(definition)
            ? readString(definition.type)
            : undefined;
          const location = isObject(definition)
            ? readString(definition.in)
            : undefined;
          const parameterName = isObject(definition)
            ? readString(definition.name)
            : undefined;
          if (
            sourceType === "apiKey" &&
            parameterName &&
            (location === "header" || location === "query")
          ) {
            return {
              schemeName,
              kind:
                location === "header"
                  ? ("API_KEY_HEADER" as const)
                  : ("API_KEY_QUERY" as const),
              parameterName,
            };
          }
          if (
            sourceType === "http" &&
            isObject(definition) &&
            readString(definition.scheme)?.toLowerCase() === "bearer"
          ) {
            return { schemeName, kind: "BEARER" as const };
          }
          warnings.push({
            code: "UNSUPPORTED_AUTH_SCHEME",
            message: `Security scheme ${schemeName} is not supported in Phase 1.`,
          });
          return {
            schemeName,
            kind: "UNSUPPORTED" as const,
            ...(sourceType ? { sourceType } : {}),
          };
        }),
      },
    ];
  });
}

export function normalizeOperation(input: {
  document: JsonObject;
  pathItem: JsonObject;
  operation: JsonObject;
}): { normalized: NormalizedOperation; warnings: OperationWarning[] } {
  const warnings: OperationWarning[] = [];
  const responses = normalizeResponses(input.operation, warnings);
  const description = readString(input.operation.description);
  const normalized: NormalizedOperation = {
    ...(description ? { description } : {}),
    inputSchema: normalizeInput(input.pathItem, input.operation, warnings),
    outputSchema: responses.outputSchema,
    errorSchema: responses.errorSchema,
    servers: normalizeServers(
      input.document,
      input.pathItem,
      input.operation,
      warnings,
    ),
    authAlternatives: normalizeAuth(input.document, input.operation, warnings),
    responseMetadata: responses.metadata,
  };
  return { normalized, warnings };
}
