import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { ResolvedAddress } from "../src/network-policy.js";
import {
  createPinnedLookup,
  fetchRemoteOpenApi,
  type RemoteHopResponse,
} from "../src/remote-fetcher.js";

const limits = {
  maxDocumentBytes: 1_024,
  maxRedirects: 3,
  timeoutMs: 100,
};

const publicAddress: ResolvedAddress = { address: "8.8.8.8", family: 4 };

function response(
  statusCode: number,
  options: {
    body?: string[];
    headers?: Record<string, string>;
    discard?: () => void;
  } = {},
): RemoteHopResponse {
  return {
    statusCode,
    headers: options.headers ?? {},
    body: (async function* () {
      for (const chunk of options.body ?? []) yield Buffer.from(chunk);
    })(),
    discard: options.discard ?? (() => undefined),
  };
}

const publicResolver = async () => [publicAddress];

describe("fetchRemoteOpenApi", () => {
  it("returns the pinned address in Node single and all-address lookup modes", async () => {
    const lookup = createPinnedLookup(publicAddress);

    await expect(
      new Promise((resolve, reject) => {
        lookup("ignored.example", { all: false }, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address, family });
        });
      }),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 });

    await expect(
      new Promise((resolve, reject) => {
        lookup("ignored.example", { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      }),
    ).resolves.toEqual([publicAddress]);
  });

  it("pins a validated address and reads a bounded successful response", async () => {
    const requestHop = vi.fn(async (_url, address: ResolvedAddress) => {
      expect(address).toEqual(publicAddress);
      return response(200, {
        body: ['{"openapi":', '"3.1.0"}'],
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchRemoteOpenApi(
      "https://api.example.com/openapi.json",
      limits,
      { resolver: publicResolver, requestHop },
    );

    expect(result).toEqual({
      content: '{"openapi":"3.1.0"}',
      mediaType: "application/json",
      byteLength: 19,
      finalUrl: "https://api.example.com/openapi.json",
      redirectCount: 0,
      sha256:
        "1f7b61c52c664d551376cf25d7c387f8c0832ba9fe00995f7d12dd1909ea0de5",
    });
  });

  it("revalidates DNS after every redirect and blocks a private target", async () => {
    const requestHop = vi.fn(async () =>
      response(302, { headers: { location: "https://internal.example/spec" } }),
    );
    const resolver = async (hostname: string) =>
      hostname === "internal.example"
        ? [{ address: "10.0.0.8", family: 4 as const }]
        : [publicAddress];

    await expect(
      fetchRemoteOpenApi("https://api.example.com/spec", limits, {
        resolver,
        requestHop,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_BLOCKED" });
    expect(requestHop).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect budget", async () => {
    const requestHop = vi.fn(async (url: URL) =>
      response(302, { headers: { location: `${url.pathname}/next` } }),
    );

    await expect(
      fetchRemoteOpenApi(
        "https://api.example.com/spec",
        { ...limits, maxRedirects: 1 },
        { resolver: publicResolver, requestHop },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_REDIRECT_LIMIT" });
    expect(requestHop).toHaveBeenCalledTimes(2);
  });

  it("rejects declared, streamed, and compressed oversized input", async () => {
    await expect(
      fetchRemoteOpenApi("https://api.example.com/spec", limits, {
        resolver: publicResolver,
        requestHop: async () =>
          response(200, { headers: { "content-length": "2048" } }),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });

    await expect(
      fetchRemoteOpenApi("https://api.example.com/spec", limits, {
        resolver: publicResolver,
        requestHop: async () => response(200, { body: ["x".repeat(1_025)] }),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });

    await expect(
      fetchRemoteOpenApi("https://api.example.com/spec", limits, {
        resolver: publicResolver,
        requestHop: async () =>
          response(200, { headers: { "content-encoding": "gzip" } }),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_UNSUPPORTED_ENCODING" });
  });

  it("applies one total timeout across the fetch", async () => {
    await expect(
      fetchRemoteOpenApi(
        "https://api.example.com/spec",
        { ...limits, timeoutMs: 10 },
        {
          resolver: publicResolver,
          requestHop: async (_url, _address, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_TIMEOUT" });
  });

  it("returns on deadline even when DNS resolution does not finish", async () => {
    await expect(
      fetchRemoteOpenApi(
        "https://api.example.com/spec",
        { ...limits, timeoutMs: 10 },
        {
          resolver: async () =>
            new Promise<ResolvedAddress[]>(() => {
              // Deliberately unresolved to model a stuck OS resolver.
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_TIMEOUT" });
  });
});
