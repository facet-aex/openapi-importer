import { describe, expect, it, vi } from "vitest";

import { ImportError } from "../src/import-error.js";
import { resolveOpenApiReferences } from "../src/reference-resolver.js";
import type { RemoteFetchResult } from "../src/remote-fetcher.js";

const limits = {
  maxDocumentBytes: 10_000,
  maxYamlAliases: 10,
  maxRedirects: 3,
  maxReferenceDepth: 8,
  maxReferenceCount: 20,
  maxOperationCount: 100,
  timeoutMs: 5_000,
};

function fetched(content: string, url: string): RemoteFetchResult {
  return {
    content,
    mediaType: "application/yaml",
    byteLength: Buffer.byteLength(content),
    finalUrl: url,
    redirectCount: 0,
    sha256: "a".repeat(64),
  };
}

describe("bounded OpenAPI reference resolution", () => {
  it("resolves an external reference only through the injected safe fetcher", async () => {
    const content = `openapi: 3.1.0
info: { title: Root, version: "1" }
paths:
  /x:
    get:
      responses:
        "200":
          $ref: "https://schemas.example/response.yaml#/Ok"
`;
    const fetchRemote = vi.fn(async (url: string) =>
      fetched("Ok:\n  description: success\n", url),
    );

    const result = await resolveOpenApiReferences(
      {
        content,
        baseUrl: "https://api.example/openapi.yaml",
        rootByteLength: Buffer.byteLength(content),
        limits,
      },
      fetchRemote,
    );

    expect(fetchRemote).toHaveBeenCalledOnce();
    expect(fetchRemote).toHaveBeenCalledWith(
      "https://schemas.example/response.yaml",
      expect.objectContaining({ maxRedirects: 3 }),
    );
    expect(result).toMatchObject({
      remoteDocumentCount: 1,
      warnings: [{ code: "REMOTE_REFERENCES_RESOLVED" }],
    });
  });

  it("rejects relative external references when paste/upload has no base URL", async () => {
    const content = `openapi: 3.1.0
info: { title: Root, version: "1" }
paths:
  /x:
    get:
      responses:
        "200": { $ref: "./response.yaml#/Ok" }
`;

    await expect(
      resolveOpenApiReferences(
        {
          content,
          rootByteLength: Buffer.byteLength(content),
          limits,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject<Partial<ImportError>>({
      code: "RELATIVE_REFERENCE_WITHOUT_BASE",
    });
  });

  it("blocks non-HTTPS and file references before any fetch", async () => {
    const httpContent = `openapi: 3.1.0
info: { title: Root, version: "1" }
paths:
  /x:
    get:
      responses:
        "200": { $ref: "http://127.0.0.1/schema.yaml#/Ok" }
`;
    const fetchRemote = vi.fn();
    await expect(
      resolveOpenApiReferences(
        {
          content: httpContent,
          baseUrl: "https://api.example/openapi.yaml",
          rootByteLength: Buffer.byteLength(httpContent),
          limits,
        },
        fetchRemote,
      ),
    ).rejects.toMatchObject<Partial<ImportError>>({
      code: "IMPORT_FETCH_BLOCKED",
    });
    expect(fetchRemote).not.toHaveBeenCalled();

    const fileContent = httpContent.replace(
      "http://127.0.0.1/schema.yaml#/Ok",
      "file:///etc/passwd",
    );
    await expect(
      resolveOpenApiReferences(
        {
          content: fileContent,
          baseUrl: "https://api.example/openapi.yaml",
          rootByteLength: Buffer.byteLength(fileContent),
          limits,
        },
        fetchRemote,
      ),
    ).rejects.toMatchObject<Partial<ImportError>>({
      code: "REFERENCE_RESOLUTION_FAILED",
    });
  });

  it("enforces total referenced bytes", async () => {
    const content = `openapi: 3.1.0
info: { title: Root, version: "1" }
paths:
  /x:
    get:
      responses:
        "200": { $ref: "https://schemas.example/large.yaml#/Ok" }
`;
    const constrained = {
      ...limits,
      maxDocumentBytes: Buffer.byteLength(content) + 5,
    };

    await expect(
      resolveOpenApiReferences(
        {
          content,
          baseUrl: "https://api.example/openapi.yaml",
          rootByteLength: Buffer.byteLength(content),
          limits: constrained,
        },
        async (url) => fetched("Ok: { description: too-large }", url),
      ),
    ).rejects.toMatchObject<Partial<ImportError>>({
      code: "REFERENCE_TOTAL_BYTES_EXCEEDED",
    });
  });

  it("enforces reference-chain depth across documents", async () => {
    const content = `openapi: 3.1.0
info: { title: Root, version: "1" }
paths:
  /x:
    get:
      responses:
        "200": { $ref: "https://schemas.example/a.yaml#/A" }
`;
    const shallow = { ...limits, maxReferenceDepth: 1 };

    await expect(
      resolveOpenApiReferences(
        {
          content,
          baseUrl: "https://api.example/openapi.yaml",
          rootByteLength: Buffer.byteLength(content),
          limits: shallow,
        },
        async (url) =>
          url.endsWith("/a.yaml")
            ? fetched('A: { $ref: "https://schemas.example/b.yaml#/B" }', url)
            : fetched("B: { description: done }", url),
      ),
    ).rejects.toMatchObject<Partial<ImportError>>({
      code: "REFERENCE_DEPTH_EXCEEDED",
    });
  });
});
