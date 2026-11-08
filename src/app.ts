import Fastify, { type FastifyInstance } from "fastify";

import type { ImporterConfig } from "./config.js";
import { ImportError } from "./import-error.js";
import { parseOpenApiDocument } from "./parser.js";

interface ParseRequestBody {
  source?: {
    kind?: "paste" | "upload";
    content?: string;
    filename?: string;
  };
}

export function buildApp(config: ImporterConfig): FastifyInstance {
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
    if (
      !source ||
      (source.kind !== "paste" && source.kind !== "upload") ||
      typeof source.content !== "string"
    ) {
      throw new ImportError(
        "INVALID_SOURCE",
        "source.kind must be paste or upload and source.content must be a string.",
      );
    }

    return parseOpenApiDocument(source.content, {
      maxDocumentBytes: config.IMPORTER_MAX_DOCUMENT_BYTES,
      maxYamlAliases: config.IMPORTER_MAX_YAML_ALIASES,
      maxReferenceDepth: config.IMPORTER_MAX_REFERENCE_DEPTH,
      maxReferenceCount: config.IMPORTER_MAX_REFERENCE_COUNT,
      maxOperationCount: config.IMPORTER_MAX_OPERATION_COUNT,
    });
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
