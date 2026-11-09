import { Buffer } from "node:buffer";

import { parseDocument } from "yaml";

import { ImportError } from "./import-error.js";
import {
  normalizeOperation,
  type NormalizedOperation,
  type OperationWarning,
} from "./operation-normalizer.js";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

type JsonObject = Record<string, unknown>;

export interface ParseLimits {
  maxDocumentBytes: number;
  maxYamlAliases: number;
  maxReferenceDepth: number;
  maxReferenceCount: number;
  maxOperationCount: number;
}

export interface OperationCandidate {
  candidateId: string;
  jsonPointer: string;
  method: Uppercase<(typeof HTTP_METHODS)[number]>;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  normalized: NormalizedOperation;
  warnings: OperationWarning[];
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export interface ParseResult {
  document: {
    openapi: string;
    title: string;
    version: string;
  };
  candidates: OperationCandidate[];
  warnings: Array<{ code: string; message: string }>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function inspectReferences(
  root: unknown,
  limits: ParseLimits,
): Array<{ code: string; message: string }> {
  const visited = new WeakSet<object>();
  let referenceCount = 0;
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        referenceCount += 1;
        if (referenceCount > limits.maxReferenceCount) {
          throw new ImportError(
            "REFERENCE_COUNT_EXCEEDED",
            "The document contains too many references.",
          );
        }
      }
      pending.push(child);
    }
  }
  return [];
}

export function parseOpenApiDocument(
  content: string,
  limits: ParseLimits,
): ParseResult {
  if (Buffer.byteLength(content, "utf8") > limits.maxDocumentBytes) {
    throw new ImportError(
      "DOCUMENT_TOO_LARGE",
      "The OpenAPI document exceeds the configured byte limit.",
      413,
    );
  }

  const parsed = parseDocument(content, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });

  if (parsed.errors.length > 0) {
    throw new ImportError(
      "INVALID_DOCUMENT",
      "The content is not valid JSON or YAML.",
    );
  }

  let document: unknown;
  try {
    document = parsed.toJS({ maxAliasCount: limits.maxYamlAliases });
  } catch {
    throw new ImportError(
      "YAML_ALIAS_LIMIT_EXCEEDED",
      "The YAML document exceeds the configured alias limit.",
    );
  }

  if (!isObject(document)) {
    throw new ImportError(
      "INVALID_OPENAPI",
      "The OpenAPI document must be an object.",
    );
  }

  const openapi = readString(document.openapi);
  if (!openapi || !/^3\.(0|1)\./u.test(openapi)) {
    throw new ImportError(
      "UNSUPPORTED_OPENAPI_VERSION",
      "Only OpenAPI 3.0.x and 3.1.x are accepted.",
    );
  }

  const info = isObject(document.info) ? document.info : {};
  const paths = document.paths;
  if (!isObject(paths)) {
    throw new ImportError(
      "MISSING_PATHS",
      "The OpenAPI document must contain a paths object.",
    );
  }

  const candidates: OperationCandidate[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!path.startsWith("/") || !isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;

      const operationId = readString(operation.operationId);
      const summary = readString(operation.summary);
      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const normalized = normalizeOperation({
        document,
        pathItem,
        operation,
      });

      candidates.push({
        candidateId: operationId ?? `${method.toUpperCase()} ${path}`,
        jsonPointer: `#/paths/${escapeJsonPointerSegment(path)}/${method}`,
        method: method.toUpperCase() as OperationCandidate["method"],
        path,
        ...(operationId ? { operationId } : {}),
        ...(summary ? { summary } : {}),
        tags,
        normalized: normalized.normalized,
        warnings: normalized.warnings,
      });

      if (candidates.length > limits.maxOperationCount) {
        throw new ImportError(
          "OPERATION_COUNT_EXCEEDED",
          "The document contains too many operations.",
        );
      }
    }
  }

  if (candidates.length === 0) {
    throw new ImportError(
      "NO_OPERATIONS",
      "The OpenAPI document does not expose any supported operations.",
    );
  }

  return {
    document: {
      openapi,
      title: readString(info.title) ?? "Untitled API",
      version: readString(info.version) ?? "unversioned",
    },
    candidates,
    warnings: inspectReferences(document, limits),
  };
}
