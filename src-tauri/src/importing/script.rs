use super::ParsedCollection;

pub(crate) fn generate_k6_script(parsed: &ParsedCollection) -> Result<String, String> {
    let requests_json = serde_json::to_string_pretty(&parsed.requests)
        .map_err(|error| format!("Failed to serialize requests: {error}"))?;
    let variables_json = serde_json::to_string_pretty(&parsed.variables)
        .map_err(|error| format!("Failed to serialize variables: {error}"))?;

    Ok(format!(
        r#"import exec from "k6/execution";
import http from "k6/http";
import {{ check, sleep }} from "k6";

const COLLECTION_VARIABLES = {variables_json};
const REQUESTS = {requests_json};

function numberEnv(name, fallback) {{
  const value = __ENV[name];
  if (!value) {{
    return fallback;
  }}

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}}

function parseJsonEnv(name, fallback) {{
  const value = __ENV[name];
  if (!value || !value.trim()) {{
    return fallback;
  }}

  try {{
    return JSON.parse(value);
  }} catch (error) {{
    throw new Error(`Invalid JSON provided in ${{name}}: ${{error instanceof Error ? error.message : String(error)}}`);
  }}
}}

function parseSelectedRequestIds() {{
  const value = parseJsonEnv("LOADRIFT_SELECTED_REQUEST_IDS_JSON", null);
  if (value === null) {{
    return null;
  }}

  if (!Array.isArray(value)) {{
    throw new Error("LOADRIFT_SELECTED_REQUEST_IDS_JSON must be a JSON array.");
  }}

  return new Set(value.filter((entry) => typeof entry === "string"));
}}

function firstNonEmptyValue(values, fallback = "") {{
  for (const value of values) {{
    if (typeof value !== "string") {{
      continue;
    }}

    const trimmed = value.trim();
    if (trimmed) {{
      return trimmed;
    }}
  }}

  return fallback;
}}

function mergeOptions(baseOptions, advancedOptions) {{
  if (!advancedOptions || typeof advancedOptions !== "object" || Array.isArray(advancedOptions)) {{
    return baseOptions;
  }}

  const merged = {{
    ...baseOptions,
    ...advancedOptions,
  }};

  if (baseOptions.thresholds || advancedOptions.thresholds) {{
    merged.thresholds = {{
      ...(baseOptions.thresholds || {{}}),
      ...(advancedOptions.thresholds || {{}}),
    }};
  }}

  return merged;
}}

function buildBasicOptions() {{
  const vus = numberEnv("K6_VUS", 10);
  const duration = __ENV.K6_DURATION || "1m";
  const rampUp = (__ENV.K6_RAMP_UP || "instant").toLowerCase();
  const rampUpTime = __ENV.K6_RAMP_UP_TIME || "30s";
  const thresholds = {{}};
  const p95Threshold = __ENV.K6_P95_THRESHOLD_MS;
  const errorRateThreshold = __ENV.K6_ERROR_RATE_THRESHOLD_PERCENT;

  if (p95Threshold) {{
    thresholds.http_req_duration = [`p(95)<${{p95Threshold}}`];
  }}

  if (errorRateThreshold) {{
    thresholds.http_req_failed = [`rate<${{Number(errorRateThreshold) / 100}}`];
  }}

  if (rampUp === "instant") {{
    return {{ vus, duration, thresholds }};
  }}

  if (rampUp === "staged") {{
    return {{
      stages: [
        {{ duration: rampUpTime, target: Math.max(1, Math.ceil(vus / 2)) }},
        {{ duration: rampUpTime, target: vus }},
        {{ duration, target: vus }},
      ],
      thresholds,
    }};
  }}

  return {{
    stages: [
      {{ duration: rampUpTime, target: vus }},
      {{ duration, target: vus }},
    ],
    thresholds,
  }};
}}

export const options = mergeOptions(
  buildBasicOptions(),
  parseJsonEnv("LOADRIFT_ADVANCED_OPTIONS_JSON", null),
);

function resolveTemplate(value, context) {{
  if (value === null || value === undefined) {{
    return value;
  }}

  return String(value).replace(/{{{{\s*([^}}\s]+)\s*}}}}/g, (_, key) => {{
    const resolved = context[key];
    return resolved === undefined || resolved === null ? "" : String(resolved);
  }});
}}

function buildContext() {{
  const hostVariableKeys = ["baseUrl", "base_url", "environment", "enviroment"];
  const runtimeOverrides = parseJsonEnv("LOADRIFT_VARIABLE_OVERRIDES_JSON", {{}});
  const context = {{
    ...COLLECTION_VARIABLES,
    ...(runtimeOverrides && typeof runtimeOverrides === "object" ? runtimeOverrides : {{}}),
  }};

  for (const key of hostVariableKeys) {{
    delete context[key];
  }}

  const configuredBaseUrl = firstNonEmptyValue([__ENV.BASE_URL]);
  if (configuredBaseUrl) {{
    for (const key of hostVariableKeys) {{
      context[key] = configuredBaseUrl;
    }}
  }}
  const authToken = firstNonEmptyValue([
    __ENV.AUTH_TOKEN,
    context.authToken,
    context.auth_token,
  ]);

  return {{
    ...context,
    baseUrl: configuredBaseUrl,
    authToken,
  }};
}}

function resolveHeaders(headers, context) {{
  const resolved = {{}};

  for (const [key, value] of Object.entries(headers || {{}})) {{
    resolved[key] = resolveTemplate(value, context);
  }}

  const hasAuthorization = Object.keys(resolved).some(
    (key) => key.toLowerCase() === "authorization",
  );

  if (!hasAuthorization && context.authToken) {{
    resolved.Authorization = `Bearer ${{context.authToken}}`;
  }}

  return resolved;
}}

function resolveUrl(url, context) {{
  const resolved = resolveTemplate(url, context);
  if (!resolved) {{
    return resolved;
  }}

  if (/^https?:\/\//i.test(resolved)) {{
    return resolved;
  }}

  if (!context.baseUrl) {{
    return resolved;
  }}

  const baseUrl = String(context.baseUrl).replace(/\/$/, "");
  const suffix = String(resolved).replace(/^\//, "");
  return `${{baseUrl}}/${{suffix}}`;
}}

function abortForAuthorizationFailure(response, request) {{
  if (response.status === 401 || response.status === 403) {{
    exec.test.abort(
      `Authorization failed for "${{request.name}}" with HTTP ${{response.status}}.`,
    );
  }}
}}

export default function () {{
  const context = buildContext();
  const selectedRequestIds = parseSelectedRequestIds();
  const selectedRequests = selectedRequestIds === null
    ? REQUESTS
    : REQUESTS.filter((request) => selectedRequestIds.has(request.id));

  if (!selectedRequests.length) {{
    throw new Error("No requests were selected to run.");
  }}

  for (const request of selectedRequests) {{
    const url = resolveUrl(request.url, context);
    const headers = resolveHeaders(request.headers, context);
    const payload = request.body ? resolveTemplate(request.body, context) : undefined;
    const response = http.request(request.method, url, payload, {{
      headers,
      tags: {{
        request_name: request.name,
        collection_name: {collection_name:?},
      }},
    }});

    abortForAuthorizationFailure(response, request);

    check(response, {{
      [`${{request.name}} status < 400`]: (result) => result.status < 400,
    }});
  }}

  sleep(1);
}}
"#,
        variables_json = variables_json,
        requests_json = requests_json,
        collection_name = parsed.name,
    ))
}
