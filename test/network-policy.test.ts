import { describe, expect, it } from "vitest";

import { ImportError } from "../src/import-error.js";
import {
  assertPublicAddress,
  parseSafeHttpsUrl,
  validateRemoteSourceUrl,
} from "../src/network-policy.js";

describe("OpenAPI remote source network policy", () => {
  it("accepts an HTTPS hostname only when every DNS answer is public", async () => {
    const result = await validateRemoteSourceUrl(
      "https://api.example.com/openapi.json",
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    );

    expect(result.url.hostname).toBe("api.example.com");
    expect(result.addresses).toHaveLength(2);
  });

  it.each([
    "http://api.example.com/openapi.json",
    "https://user:password@api.example.com/openapi.json",
    "https://api.example.com:8443/openapi.json",
    "https://localhost/openapi.json",
    "https://metadata.google.internal/openapi.json",
    "https://service.local/openapi.json",
    "https://127.0.0.1/openapi.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/openapi.json",
  ])("blocks unsafe URL %s", (value) => {
    expect(() => parseSafeHttpsUrl(value)).toThrowError(ImportError);
  });

  it("rejects a hostname when any DNS answer reaches a private network", async () => {
    await expect(
      validateRemoteSourceUrl(
        "https://api.example.com/openapi.json",
        async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      ),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_BLOCKED" });
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("blocks non-public address %s", (address) => {
    expect(() => assertPublicAddress(address)).toThrowError(ImportError);
  });

  it("fails closed when DNS resolution fails or returns no answers", async () => {
    await expect(
      validateRemoteSourceUrl(
        "https://api.example.com/openapi.json",
        async () => [],
      ),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_FAILED" });
    await expect(
      validateRemoteSourceUrl(
        "https://api.example.com/openapi.json",
        async () => {
          throw new Error("resolver unavailable");
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_FETCH_FAILED" });
  });
});
