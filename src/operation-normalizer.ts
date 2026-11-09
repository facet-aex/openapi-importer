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

function resolveJsonPointer(document: JsonObject, reference: string): unknown {
  if (!reference.startsWith("#")) return undefined;
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (fragment === "") return document;
  if (!fragment.startsWith("/")) return undefined;
  let current: unknown = document;
  for (const encodedSegment of fragment.slice(1).split("/")) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.prototype.hasOwnProperty.call(current, segment))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function definitionName(reference: string, used: Map<string, string>): string {
  const fragment = reference.slice(reference.lastIndexOf("/") + 1);
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Keep the encoded fragment; it is still safe to normalize below.
  }
  const base =
    decoded
      .replaceAll("~1", "/")
      .replaceAll("~0", "~")
      .replace(/[^A-Za-z0-9._-]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || "schema";
  if (!used.has(base) || used.get(base) === reference) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function resolveReferencedObject(
  document: JsonObject,
  value: unknown,
  seen = new Set<string>(),
): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const reference = readString(value.$ref);
  if (!reference) return value;
  if (seen.has(reference)) return undefined;
  const target = resolveJsonPointer(document, reference);
  if (!isObject(target)) return undefined;
  seen.add(reference);
  return resolveReferencedObject(document, target, seen);
}

const omittedSchemaKeywords = new Set(["example", "examples", "default"]);

function normalizeSchemaClosure(
  value: unknown,
  document: JsonObject,
  warnings: OperationWarning[],
): JsonSchema {
  const definitions = new Map<string, JsonSchema>();
  const referenceNames = new Map<string, string>();
  const usedNames = new Map<string, string>();

  const schemaNameMaps = new Set([
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
  ]);
  const normalize = (current: unknown, isNameMap = false): unknown => {
    if (Array.isArray(current)) return current.map((item) => normalize(item));
    if (!isObject(current)) return current;

    const nullable = current.nullable === true;
    const normalized: JsonObject = {};
    for (const [key, child] of Object.entries(current)) {
      if (
        !isNameMap &&
        (key === "nullable" ||
          key.toLowerCase().startsWith("x-") ||
          omittedSchemaKeywords.has(key))
      )
        continue;
      if (key === "$ref" && typeof child === "string") {
        const target = resolveJsonPointer(document, child);
        if (target === undefined) {
          warnings.push({
            code: "UNRESOLVED_SCHEMA_REFERENCE",
            message:
              "A schema reference could not be included in the candidate closure.",
          });
          continue;
        }
        let name = referenceNames.get(child);
        if (!name) {
          name = definitionName(child, usedNames);
          referenceNames.set(child, name);
          usedNames.set(name, child);
          definitions.set(name, {});
          const definition = normalize(target);
          definitions.set(
            name,
            typeof definition === "boolean" || isObject(definition)
              ? definition
              : {},
          );
        }
        normalized.$ref = `#/$defs/${name}`;
      } else {
        normalized[key] = normalize(child, schemaNameMaps.has(key));
      }
    }
    return nullable ? { anyOf: [normalized, { type: "null" }] } : normalized;
  };

  const root = normalize(value);
  const normalizedRoot: JsonSchema =
    typeof root === "boolean" || isObject(root) ? root : {};
  if (definitions.size === 0 || typeof normalizedRoot === "boolean") {
    return normalizedRoot;
  }
  normalizedRoot.$defs = Object.fromEntries(definitions);
  return normalizedRoot;
}

function readContentSchema(content: unknown): {
  mediaType?: string;
  schema?: unknown;
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
  return { mediaType, schema: media.schema };
}

const parameterLocations = ["path", "query", "header", "cookie"] as const;

function normalizeInput(
  document: JsonObject,
  pathItem: JsonObject,
  operation: JsonObject,
  warnings: OperationWarning[],
): JsonSchema {
  const merged = new Map<string, JsonObject>();
  for (const parameters of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(parameters)) continue;
    for (const parameter of parameters) {
      const resolvedParameter = resolveReferencedObject(document, parameter);
      if (!resolvedParameter) {
        warnings.push({
          code: "UNRESOLVED_PARAMETER_REFERENCE",
          message: "A referenced parameter could not be resolved safely.",
        });
        continue;
      }
      const location = readString(resolvedParameter.in);
      const name = readString(resolvedParameter.name);
      if (!location || !name) continue;
      merged.set(`${location}\u0000${name}`, resolvedParameter);
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
      namespaceProperties[name] = contentSchema ?? parameter.schema ?? {};
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
    const requestBody = resolveReferencedObject(
      document,
      operation.requestBody,
    );
    if (!requestBody) {
      warnings.push({
        code: "UNRESOLVED_REQUEST_BODY_REFERENCE",
        message: "A referenced request body could not be resolved safely.",
      });
    } else {
      const body = readContentSchema(requestBody.content);
      if (body.schema !== undefined) {
        properties.body = body.schema;
        if (requestBody.required === true) requiredNamespaces.push("body");
      } else {
        warnings.push({
          code: "MISSING_REQUEST_BODY_SCHEMA",
          message: "The request body does not define a supported schema.",
        });
      }
    }
  }

  return normalizeSchemaClosure(
    {
      type: "object",
      additionalProperties: false,
      properties,
      ...(requiredNamespaces.length > 0
        ? { required: requiredNamespaces }
        : {}),
    },
    document,
    warnings,
  );
}

function statusRank(status: string): number {
  if (/^\d{3}$/u.test(status)) return Number(status);
  if (/^[1-5]XX$/iu.test(status)) return Number(status[0]) * 100 + 99;
  return 9999;
}

function normalizeResponses(
  document: JsonObject,
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
    const response = resolveReferencedObject(document, success[1]);
    if (response) {
      const selected = readContentSchema(response.content);
      outputSchema = normalizeSchemaClosure(
        selected.schema ?? {},
        document,
        warnings,
      );
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
    const resolved = resolveReferencedObject(document, response);
    if (!resolved) return [];
    const schema = readContentSchema(resolved.content).schema;
    return schema === undefined
      ? []
      : [normalizeSchemaClosure(schema, document, warnings)];
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
          const definition = resolveReferencedObject(
            document,
            definitions[schemeName],
          );
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
  const responses = normalizeResponses(
    input.document,
    input.operation,
    warnings,
  );
  const description = readString(input.operation.description);
  const normalized: NormalizedOperation = {
    ...(description ? { description } : {}),
    inputSchema: normalizeInput(
      input.document,
      input.pathItem,
      input.operation,
      warnings,
    ),
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
