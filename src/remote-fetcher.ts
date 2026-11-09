import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";

import { ImportError } from "./import-error.js";
import {
  type HostnameResolver,
  type ResolvedAddress,
  validateRemoteSourceUrl,
} from "./network-policy.js";

export interface RemoteFetchLimits {
  maxDocumentBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}

export interface RemoteHopResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  discard(): void;
}

export type RemoteHopRequester = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
) => Promise<RemoteHopResponse>;

export interface RemoteFetchResult {
  content: string;
  mediaType: string | null;
  byteLength: number;
  finalUrl: string;
  redirectCount: number;
  sha256: string;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export function createPinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

const defaultHopRequester: RemoteHopRequester = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent: false,
        headers: {
          accept:
            "application/vnd.oai.openapi+json, application/json, application/yaml, text/yaml, */*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "FACET-OpenAPI-Importer/0.1",
        },
        lookup: createPinnedLookup(address),
        maxHeaderSize: 16_384,
        method: "GET",
        signal,
      },
      (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          discard: () => response.destroy(),
        });
      },
    );
    request.once("error", reject);
    request.end();
  });

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBoundedBody(
  response: RemoteHopResponse,
  maxDocumentBytes: number,
): Promise<{ content: string; byteLength: number; sha256: string }> {
  const encoding = firstHeader(response.headers["content-encoding"]);
  if (encoding && encoding.toLowerCase() !== "identity") {
    response.discard();
    throw new ImportError(
      "IMPORT_UNSUPPORTED_ENCODING",
      "Compressed OpenAPI responses are not accepted.",
      415,
    );
  }

  const lengthHeader = firstHeader(response.headers["content-length"]);
  if (lengthHeader) {
    const declaredLength = Number(lengthHeader);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxDocumentBytes
    ) {
      response.discard();
      throw new ImportError(
        "DOCUMENT_TOO_LARGE",
        "The remote OpenAPI document exceeds the configured byte limit.",
        413,
      );
    }
  }

  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxDocumentBytes) {
      response.discard();
      throw new ImportError(
        "DOCUMENT_TOO_LARGE",
        "The remote OpenAPI document exceeds the configured byte limit.",
        413,
      );
    }
    hash.update(buffer);
    chunks.push(buffer);
  }
  return {
    content: Buffer.concat(chunks).toString("utf8"),
    byteLength,
    sha256: hash.digest("hex"),
  };
}

export async function fetchRemoteOpenApi(
  sourceUrl: string,
  limits: RemoteFetchLimits,
  dependencies: {
    resolver?: HostnameResolver;
    requestHop?: RemoteHopRequester;
  } = {},
): Promise<RemoteFetchResult> {
  const controller = new AbortController();
  const requestHop = dependencies.requestHop ?? defaultHopRequester;
  let timeout: NodeJS.Timeout | undefined;

  const execute = async (): Promise<RemoteFetchResult> => {
    let currentUrl = sourceUrl;
    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        const validated = await validateRemoteSourceUrl(
          currentUrl,
          dependencies.resolver,
        );
        if (controller.signal.aborted) {
          throw new Error("remote fetch deadline exceeded");
        }
        const address = validated.addresses[0];
        if (!address) {
          throw new ImportError(
            "IMPORT_FETCH_FAILED",
            "The source hostname has no usable IP address.",
          );
        }

        const response = await requestHop(
          validated.url,
          address,
          controller.signal,
        );
        if (redirectStatuses.has(response.statusCode)) {
          response.discard();
          if (redirectCount >= limits.maxRedirects) {
            throw new ImportError(
              "IMPORT_REDIRECT_LIMIT",
              "The remote OpenAPI source exceeded the redirect limit.",
            );
          }
          const location = firstHeader(response.headers.location);
          if (!location) {
            throw new ImportError(
              "IMPORT_FETCH_FAILED",
              "The remote source returned a redirect without a location.",
            );
          }
          currentUrl = new URL(location, validated.url).href;
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.discard();
          throw new ImportError(
            "IMPORT_FETCH_FAILED",
            `The remote source returned HTTP ${response.statusCode}.`,
            502,
          );
        }

        const body = await readBoundedBody(response, limits.maxDocumentBytes);
        return {
          ...body,
          mediaType: firstHeader(response.headers["content-type"]) ?? null,
          finalUrl: validated.url.href,
          redirectCount,
        };
      }
    } catch (error) {
      if (error instanceof ImportError) throw error;
      if (controller.signal.aborted) {
        throw new ImportError(
          "IMPORT_FETCH_TIMEOUT",
          "The remote OpenAPI fetch exceeded the total timeout.",
          504,
        );
      }
      throw new ImportError(
        "IMPORT_FETCH_FAILED",
        "The remote OpenAPI source could not be fetched.",
        502,
      );
    }
  };

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new ImportError(
          "IMPORT_FETCH_TIMEOUT",
          "The remote OpenAPI fetch exceeded the total timeout.",
          504,
        ),
      );
    }, limits.timeoutMs);
  });

  try {
    return await Promise.race([execute(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
