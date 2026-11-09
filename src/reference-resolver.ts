import $RefParser from "@apidevtools/json-schema-ref-parser";
import { parseDocument } from "yaml";

import { ImportError } from "./import-error.js";
import { parseSafeHttpsUrl } from "./network-policy.js";
import type { ParseLimits } from "./parser.js";
import {
  fetchRemoteOpenApi,
  type RemoteFetchResult,
} from "./remote-fetcher.js";

type FetchRemote = typeof fetchRemoteOpenApi;

export interface ReferenceResolutionResult {
  document: Record<string, unknown>;
  referenceCount: number;
  remoteDocumentCount: number;
  totalByteLength: number;
  warnings: Array<{ code: string; message: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const wrappedImportCodes = new Set([
  "RELATIVE_REFERENCE_WITHOUT_BASE",
  "REFERENCE_TOTAL_BYTES_EXCEEDED",
  "REFERENCE_TIMEOUT",
  "INVALID_SOURCE_URL",
  "IMPORT_FETCH_BLOCKED",
  "IMPORT_FETCH_FAILED",
  "IMPORT_FETCH_TIMEOUT",
  "IMPORT_REDIRECT_LIMIT",
  "IMPORT_UNSUPPORTED_ENCODING",
  "DOCUMENT_TOO_LARGE",
]);

function unwrapResolverImportError(error: unknown): ImportError | undefined {
  if (!isObject(error) || typeof error.ioErrorCode !== "string") {
    return undefined;
  }
  if (!wrappedImportCodes.has(error.ioErrorCode)) return undefined;
  const statusCode =
    error.ioErrorCode === "DOCUMENT_TOO_LARGE" ||
    error.ioErrorCode === "REFERENCE_TOTAL_BYTES_EXCEEDED"
      ? 413
      : error.ioErrorCode === "IMPORT_UNSUPPORTED_ENCODING"
        ? 415
        : error.ioErrorCode === "IMPORT_FETCH_TIMEOUT"
          ? 504
          : error.ioErrorCode === "REFERENCE_TIMEOUT"
            ? 408
            : error.ioErrorCode === "IMPORT_FETCH_FAILED"
              ? 502
              : 400;
  return new ImportError(
    error.ioErrorCode,
    typeof error.message === "string"
      ? error.message
      : "Reference resolution failed.",
    statusCode,
  );
}

function parseReferenceDocument(
  content: string,
  maxYamlAliases: number,
): unknown {
  const parsed = parseDocument(content, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0) {
    throw new ImportError(
      "INVALID_REFERENCE_DOCUMENT",
      "A referenced document is not valid JSON or YAML.",
    );
  }
  try {
    return parsed.toJS({ maxAliasCount: maxYamlAliases });
  } catch {
    throw new ImportError(
      "REFERENCE_YAML_ALIAS_LIMIT_EXCEEDED",
      "A referenced YAML document exceeds the alias limit.",
    );
  }
}

export async function resolveOpenApiReferences(
  input: {
    content: string;
    baseUrl?: string;
    rootByteLength: number;
    limits: ParseLimits & { maxRedirects: number; timeoutMs: number };
  },
  fetchRemote: FetchRemote = fetchRemoteOpenApi,
): Promise<ReferenceResolutionResult> {
  const root = parseReferenceDocument(
    input.content,
    input.limits.maxYamlAliases,
  );
  if (!isObject(root)) {
    throw new ImportError(
      "INVALID_OPENAPI",
      "The OpenAPI document must be an object.",
    );
  }

  const syntheticRoot = "https://facet.invalid/__openapi_root__.yaml";
  const rootUrl = input.baseUrl ?? syntheticRoot;
  const deadline = Date.now() + input.limits.timeoutMs;
  let totalByteLength = input.rootByteLength;
  let referenceCount = 0;
  const remoteDocuments = new Map<string, RemoteFetchResult>();

  try {
    const parser = new $RefParser<Record<string, unknown>>();
    const document = await parser.bundle(rootUrl, root, {
      mutateInputSchema: false,
      continueOnError: false,
      parse: {
        json: false,
        yaml: false,
        text: false,
        binary: false,
        facetDocument: {
          order: 1,
          canParse: true,
          parse: (file) =>
            parseReferenceDocument(
              Buffer.isBuffer(file.data)
                ? file.data.toString("utf8")
                : file.data,
              input.limits.maxYamlAliases,
            ),
        },
      },
      resolve: {
        external: true,
        file: false,
        http: false,
        facetHttps: {
          order: 1,
          canRead: (file) => /^https?:\/\//iu.test(file.url),
          read: async (file) => {
            if (!input.baseUrl && !/^https:\/\//iu.test(file.reference ?? "")) {
              throw new ImportError(
                "RELATIVE_REFERENCE_WITHOUT_BASE",
                "Relative external references require a URL source base.",
              );
            }
            const requested = parseSafeHttpsUrl(file.url).href;
            if (requested.startsWith(syntheticRoot)) {
              throw new ImportError(
                "RELATIVE_REFERENCE_WITHOUT_BASE",
                "Relative external references require a URL source base.",
              );
            }
            const remainingBytes =
              input.limits.maxDocumentBytes - totalByteLength;
            const remainingTime = deadline - Date.now();
            if (remainingBytes <= 0) {
              throw new ImportError(
                "REFERENCE_TOTAL_BYTES_EXCEEDED",
                "Referenced documents exceed the total byte limit.",
                413,
              );
            }
            if (remainingTime <= 0) {
              throw new ImportError(
                "REFERENCE_TIMEOUT",
                "Reference resolution exceeded the total timeout.",
                408,
              );
            }
            const fetched = await fetchRemote(requested, {
              maxDocumentBytes: remainingBytes,
              maxRedirects: input.limits.maxRedirects,
              timeoutMs: remainingTime,
            });
            totalByteLength += fetched.byteLength;
            if (totalByteLength > input.limits.maxDocumentBytes) {
              throw new ImportError(
                "REFERENCE_TOTAL_BYTES_EXCEEDED",
                "Referenced documents exceed the total byte limit.",
                413,
              );
            }
            remoteDocuments.set(fetched.finalUrl, fetched);
            return fetched.content;
          },
        },
      },
      resolveExcludedPathMatcher: (_path, value) => {
        if (isObject(value) && typeof value.$ref === "string") {
          referenceCount += 1;
          if (referenceCount > input.limits.maxReferenceCount) {
            throw new ImportError(
              "REFERENCE_COUNT_EXCEEDED",
              "The document contains too many references.",
            );
          }
        }
        return false;
      },
      bundle: { optimizeInternalRefs: false },
      dereference: {
        maxDepth: input.limits.maxReferenceDepth,
        circular: "ignore",
      },
    });

    return {
      document,
      referenceCount,
      remoteDocumentCount: remoteDocuments.size,
      totalByteLength,
      warnings:
        remoteDocuments.size > 0
          ? [
              {
                code: "REMOTE_REFERENCES_RESOLVED",
                message:
                  "Remote references were resolved through the isolated fetch policy.",
              },
            ]
          : [],
    };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    const unwrapped = unwrapResolverImportError(error);
    if (unwrapped) throw unwrapped;
    if (
      error instanceof RangeError &&
      error.message.includes("Maximum dereference depth")
    ) {
      throw new ImportError(
        "REFERENCE_DEPTH_EXCEEDED",
        "The document exceeds the reference-depth limit.",
      );
    }
    throw new ImportError(
      "REFERENCE_RESOLUTION_FAILED",
      "The OpenAPI reference graph could not be resolved safely.",
    );
  }
}
