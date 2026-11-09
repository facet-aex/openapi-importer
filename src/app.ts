import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { ImporterConfig } from "./config.js";
import { ImportError } from "./import-error.js";
import { parseOpenApiDocument } from "./parser.js";
import { fetchRemoteOpenApi } from "./remote-fetcher.js";

interface ParseRequestBody {
  source?: {
    kind?: "paste" | "upload" | "url";
    content?: string;
    filename?: string;
    url?: string;
  };
}

export interface ImporterAppDependencies {
  fetchRemote?: typeof fetchRemoteOpenApi;
}

export function buildApp(
  config: ImporterConfig,
  dependencies: ImporterAppDependencies = {},
): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV !== "test",
    requestIdHeader: "x-request-id",
    bodyLimit: config.IMPORTER_MAX_DOCUMENT_BYTES + 65_536,
  });

  app.get("/health/live", async () => ({
    service: "openapi-importer",
    status: "ok" as const,
    environment: config.FACET_ENV,
    timestamp: new Date().toISOString(),
  }));

  app.post<{ Body: ParseRequestBody }>("/v1/imports/parse", async (request) => {
    const source = request.body?.source;
    if (!source) {
      throw new ImportError("INVALID_SOURCE", "A source is required.");
    }

    let content: string;
    let sourceMetadata: Record<string, unknown>;
    if (source.kind === "url" && typeof source.url === "string") {
      const fetched = await (dependencies.fetchRemote ?? fetchRemoteOpenApi)(
        source.url,
        {
          maxDocumentBytes: config.IMPORTER_MAX_DOCUMENT_BYTES,
          maxRedirects: config.IMPORTER_MAX_REDIRECTS,
          timeoutMs: config.IMPORTER_TIMEOUT_MS,
        },
      );
      content = fetched.content;
      sourceMetadata = {
        kind: "url",
        sha256: fetched.sha256,
        byteLength: fetched.byteLength,
        mediaType: fetched.mediaType,
        finalUrl: fetched.finalUrl,
        redirectCount: fetched.redirectCount,
      };
    } else if (
      (source.kind === "paste" || source.kind === "upload") &&
      typeof source.content === "string"
    ) {
      content = source.content;
      sourceMetadata = {
        kind: source.kind,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        byteLength: Buffer.byteLength(content, "utf8"),
      };
    } else {
      throw new ImportError(
        "INVALID_SOURCE",
        "Use url with source.url, or paste/upload with source.content.",
      );
    }

    const parsed = parseOpenApiDocument(content, {
      maxDocumentBytes: config.IMPORTER_MAX_DOCUMENT_BYTES,
      maxYamlAliases: config.IMPORTER_MAX_YAML_ALIASES,
      maxReferenceDepth: config.IMPORTER_MAX_REFERENCE_DEPTH,
      maxReferenceCount: config.IMPORTER_MAX_REFERENCE_COUNT,
      maxOperationCount: config.IMPORTER_MAX_OPERATION_COUNT,
    });
    return { ...parsed, source: sourceMetadata };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ImportError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
        },
      });
    }

    request.log.error(
      { err: error, requestId: request.id },
      "import request failed",
    );
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The document could not be processed.",
        requestId: request.id,
      },
    });
  });

  return app;
}
