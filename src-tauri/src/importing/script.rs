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
const REQUESTS_BY_ID = Object.fromEntries(REQUESTS.map((request) => [request.id, request]));

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

function parseRequestWeights() {{
  const value = parseJsonEnv("LOADRIFT_REQUEST_WEIGHTS_JSON", {{}});
  if (!value || typeof value !== "object" || Array.isArray(value)) {{
    throw new Error("LOADRIFT_REQUEST_WEIGHTS_JSON must be a JSON object.");
  }}

  return value;
}}

function resolveTrafficMode() {{
  const value = (__ENV.LOADRIFT_TRAFFIC_MODE || "sequential").toLowerCase();
  return value === "weighted" ? "weighted" : "sequential";
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

function shouldSkipBasicLoadShape() {{
  return (__ENV.LOADRIFT_SKIP_BASIC_LOAD_SHAPE || "").toLowerCase() === "true";
}}

function getSelectedRequests() {{
  const selectedRequestIds = parseSelectedRequestIds();
  return selectedRequestIds === null
    ? REQUESTS
    : REQUESTS.filter((request) => selectedRequestIds.has(request.id));
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

  if (shouldSkipBasicLoadShape()) {{
    return {{ thresholds }};
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

function encodeRfc3986Component(value) {{
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${{character.charCodeAt(0).toString(16).toUpperCase()}}`
  );
}}

function resolveTemplate(value, context, options = {{}}) {{
  if (value === null || value === undefined) {{
    return value;
  }}

  const text = String(value);
  const encodedOccurrences = new Set(options.encodedVariableOccurrences || []);
  let resolved = "";
  let searchIndex = 0;
  let occurrenceIndex = 0;

  while (true) {{
    const start = text.indexOf("{{{{", searchIndex);
    if (start === -1) {{
      return resolved + text.slice(searchIndex);
    }}

    resolved += text.slice(searchIndex, start);
    const tokenStart = start + 2;
    const tokenEnd = text.indexOf("}}}}", tokenStart);
    if (tokenEnd === -1) {{
      return resolved + text.slice(start);
    }}

    const key = text.slice(tokenStart, tokenEnd).trim();
    const replacement = context[key];
    if (replacement !== undefined && replacement !== null) {{
      const resolvedValue = String(replacement);
      resolved += options.encodeVariableValues || encodedOccurrences.has(occurrenceIndex)
        ? encodeRfc3986Component(resolvedValue)
        : resolvedValue;
    }}

    occurrenceIndex += 1;
    searchIndex = tokenEnd + 2;
  }}
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

function resolveUrl(request, context) {{
  const resolved = resolveTemplate(request.url, context, {{
    encodedVariableOccurrences: request.urlEncodedVariableOccurrences || [],
  }});
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

function resolveRequestWeight(request, requestWeights) {{
  const rawWeight = requestWeights[request.id];
  if (!Number.isFinite(rawWeight)) {{
    return 1;
  }}

  return Math.max(0, Math.trunc(rawWeight));
}}

function selectRunnableRequests(selectedRequests, trafficMode, requestWeights) {{
  if (trafficMode !== "weighted") {{
    return selectedRequests;
  }}

  return selectedRequests.filter((request) => resolveRequestWeight(request, requestWeights) > 0);
}}

function buildWeightedSchedule(requests, requestWeights) {{
  const schedule = [];

  for (const request of requests) {{
    const weight = resolveRequestWeight(request, requestWeights);
    for (let index = 0; index < weight; index += 1) {{
      schedule.push(request.id);
    }}
  }}

  if (!schedule.length) {{
    throw new Error("Weighted mix requires at least one selected request with a positive weight.");
  }}

  return schedule;
}}

function pickWeightedRequestId(schedule) {{
  const iterationIndex = Number(exec.scenario.iterationInTest || 0);
  return schedule[iterationIndex % schedule.length];
}}

function findRequestById(requestId) {{
  const request = REQUESTS_BY_ID[requestId];
  if (!request) {{
    throw new Error(`Could not find request ${{requestId}} in the imported collection.`);
  }}

  return request;
}}

function executeRequest(request, context, trafficMode) {{
  const url = resolveUrl(request, context);
  const headers = resolveHeaders(request.headers, context);
  const payload = request.body
    ? resolveTemplate(request.body, context, {{
        encodeVariableValues: request.encodeBodyVariableValues === true,
      }})
    : undefined;
  const response = http.request(request.method, url, payload, {{
    headers,
    tags: {{
      request_id: request.id,
      request_name: request.name,
      collection_name: {collection_name:?},
      traffic_mode: trafficMode,
    }},
  }});

  abortForAuthorizationFailure(response, request);

  check(response, {{
    [`${{request.name}} status < 400`]: (result) => result.status < 400,
  }});
}}

export default function () {{
  const context = buildContext();
  const requestWeights = parseRequestWeights();
  const trafficMode = resolveTrafficMode();
  const selectedRequests = getSelectedRequests();
  const runnableRequests = selectRunnableRequests(selectedRequests, trafficMode, requestWeights);

  if (!runnableRequests.length) {{
    throw new Error(
      trafficMode === "weighted"
        ? "Weighted mix requires at least one selected request with a positive weight."
        : "No requests were selected to run.",
    );
  }}

  if (trafficMode === "weighted") {{
    const weightedSchedule = buildWeightedSchedule(runnableRequests, requestWeights);
    executeRequest(findRequestById(pickWeightedRequestId(weightedSchedule)), context, trafficMode);
  }} else {{
    for (const request of runnableRequests) {{
      executeRequest(request, context, trafficMode);
    }}
  }}

  sleep(1);
}}
"#,
        variables_json = variables_json,
        requests_json = requests_json,
        collection_name = parsed.name,
    ))
}
