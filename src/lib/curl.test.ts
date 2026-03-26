import { describe, expect, it } from "vitest";
import { normalizeBearerTokenInput, parseCurlCommand } from "./curl";

describe("curl helpers", () => {
  it("extracts the origin and bearer token from a pasted curl command", () => {
    const parsed = parseCurlCommand(
      "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer integration-token'",
    );

    expect(parsed.url).toBe("https://api.example.com/entities/alpha");
    expect(parsed.baseUrl).toBe("https://api.example.com");
    expect(parsed.authToken).toBe("integration-token");
  });

  it("parses multiline Postman-style curl commands with line continuations", () => {
    const parsed = parseCurlCommand(
      "curl --location 'https://api.example.com/entities/alpha' \\\n--header 'Authorization: Bearer integration-token'",
    );

    expect(parsed.baseUrl).toBe("https://api.example.com");
    expect(parsed.authToken).toBe("integration-token");
  });

  it("treats authorization header names case-insensitively", () => {
    const parsed = parseCurlCommand(
      "curl --location 'https://api.example.com/entities/alpha' --header 'AUTHORIZATION: Bearer integration-token'",
    );

    expect(parsed.authToken).toBe("integration-token");
  });

  it("normalizes raw header values and plain bearer tokens", () => {
    expect(
      normalizeBearerTokenInput("Authorization: Bearer integration-token"),
    ).toBe("integration-token");
    expect(normalizeBearerTokenInput("Bearer integration-token")).toBe(
      "integration-token",
    );
    expect(normalizeBearerTokenInput("integration-token")).toBe(
      "integration-token",
    );
  });
});
