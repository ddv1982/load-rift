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
    expect(parsed.headers.Authorization).toBe("Bearer integration-token");
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

  it("parses Postman cURL request headers and JSON body generically", () => {
    const parsed =
      parseCurlCommand(`curl --location 'https://acc.crvherdoptimizer.com/breeding-catalog/catalog/api/module/build' \\
--header 'Customerid: f47ac10b-58cc-4372-a567-0e02b2c3d479' \\
--header 'Modulename: Inbreeding' \\
--header 'Applicationname: herdoptimizer' \\
--header 'Content-Type: application/json' \\
--header 'Authorization: Bearer e.' \\
--data '{
    "module": "Inbreeding",
    "components": [
      {
        "component": "InbreedingAdvicesOverviewTable",
        "f47ac10b-58cc-4372-a567-0e02b2c3d479": {
          "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        }
      }
    ]
  }'`);

    expect(parsed.method).toBe("POST");
    expect(parsed.baseUrl).toBe("https://acc.crvherdoptimizer.com");
    expect(parsed.authToken).toBe("e.");
    expect(parsed.headers).toMatchObject({
      Customerid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      Modulename: "Inbreeding",
      Applicationname: "herdoptimizer",
      "Content-Type": "application/json",
      Authorization: "Bearer e.",
    });
    expect(parsed.body?.value).toContain('"module": "Inbreeding"');
  });

  it("parses explicit methods, lower-case headers, and data-raw", () => {
    const parsed = parseCurlCommand(
      "curl -X PATCH --url=https://api.example.com/entities/alpha -H 'x-customer-id: 123' --data-raw '{\"name\":\"alpha\"}'",
    );

    expect(parsed.method).toBe("PATCH");
    expect(parsed.url).toBe("https://api.example.com/entities/alpha");
    expect(parsed.headers["x-customer-id"]).toBe("123");
    expect(parsed.body).toEqual({
      sourceFlag: "--data-raw",
      value: '{"name":"alpha"}',
    });
  });

  it("keeps non-bearer authorization as a generic header", () => {
    const parsed = parseCurlCommand(
      "curl 'https://api.example.com/entities/alpha' -H 'Authorization: Basic abc123'",
    );

    expect(parsed.authToken).toBeNull();
    expect(parsed.headers.Authorization).toBe("Basic abc123");
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
