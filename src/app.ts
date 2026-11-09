import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { ImporterConfig } from "./config.js";
import { ImportError } from "./import-error.js";
import { parseOpenApiDocument } from "./parser.js";
import { fetchRemoteOpenApi } from "./remote-fetcher.js";

const limitsSchema = z.object({
  maxDocumentBytes: z.number().int().positive(),
  maxYamlAliases: z.number().int().min(0),
  maxRedirects: z.number().int().min(0),
  maxReferenceDepth: z.number().int().positive(),
  maxReferenceCount: z.number().int().positive(),
  maxOperationCount: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

const requestSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.enum(["paste", "upload"]),
      content: z.string().min(1),
      filename: z.string().min(1).max(255).optional(),
    }),
    z.object({ kind: z.literal("url"), url: z.string().url().max(2_048) }),
  ]),
  limits: limitsSchema.optional(),
});

type ImportLimits = z.infer<typeof limitsSchema>;

function configuredLimits(config: ImporterConfig): ImportLimits {
  return {
    maxDocumentBytes: config.IMPORTER_MAX_DOCUMENT_BYTES,
    maxYamlAliases: config.IMPORTER_MAX_YAML_ALIASES,
    maxRedirects: config.IMPORTER_MAX_REDIRECTS,
    maxReferenceDepth: config.IMPORTER_MAX_REFERENCE_DEPTH,
    maxReferenceCount: config.IMPORTER_MAX_REFERENCE_COUNT,
    maxOperationCount: config.IMPORTER_MAX_OPERATION_COUNT,
    timeoutMs: config.IMPORTER_TIMEOUT_MS,
  };
}

function resolveLimits(
  requested: ImportLimits | undefined,
  maximums: ImportLimits,
): ImportLimits {
  if (!requested) return maximums;
  for (const key of Object.keys(maximums) as Array<keyof ImportLimits>) {
    if (requested[key] > maximums[key]) {
      throw new ImportError(
        "IMPORT_LIMIT_EXCEEDS_POLICY",
        `Requested ${key} exceeds the importer deployment policy.`,
      );
    }
  }
  return requested;
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

  app.post("/v1/imports/parse", async (request) => {
    const parsedRequest = requestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      throw new ImportError(
        "INVALID_SOURCE",
        "A valid OpenAPI source and optional limits are required.",
      );
    }
    const { source } = parsedRequest.data;
    const limits = resolveLimits(
      parsedRequest.data.limits,
      configuredLimits(config),
    );

    let content: string;
    let sourceMetadata: Record<string, unknown>;
    if (source.kind === "url" && typeof source.url === "string") {
      const fetched = await (dependencies.fetchRemote ?? fetchRemoteOpenApi)(
        source.url,
        {
          maxDocumentBytes: limits.maxDocumentBytes,
          maxRedirects: limits.maxRedirects,
          timeoutMs: limits.timeoutMs,
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
    } else if (source.kind === "paste" || source.kind === "upload") {
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
      maxDocumentBytes: limits.maxDocumentBytes,
      maxYamlAliases: limits.maxYamlAliases,
      maxReferenceDepth: limits.maxReferenceDepth,
      maxReferenceCount: limits.maxReferenceCount,
      maxOperationCount: limits.maxOperationCount,
    });
    return {
      ...parsed,
      source: sourceMetadata,
      snapshot: { content },
      limits,
    };
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
