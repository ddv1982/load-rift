use std::collections::BTreeMap;

use super::ParsedCollection;

pub(crate) fn generate_k6_script(parsed: &ParsedCollection) -> Result<String, String> {
    let requests_json = serde_json::to_string_pretty(&parsed.requests)
        .map_err(|error| format!("Failed to serialize requests: {error}"))?;
    let variables_json = serde_json::to_string_pretty(&parsed.variables)
        .map_err(|error| format!("Failed to serialize variables: {error}"))?;
    let request_exec_names: BTreeMap<String, String> = parsed
        .requests
        .iter()
        .enumerate()
        .map(|(index, request)| (request.id.clone(), format!("loadriftRequest{index}")))
        .collect();
    let request_exec_names_json = serde_json::to_string_pretty(&request_exec_names)
        .map_err(|error| format!("Failed to serialize request exec names: {error}"))?;
    let request_exec_functions = parsed
        .requests
        .iter()
        .enumerate()
        .map(|(index, request)| {
            format!(
                "export function loadriftRequest{index}() {{\n  executeRequestById({request_id:?}, \"weighted\");\n}}",
                request_id = request.id,
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    Ok(format!(
        r#"import exec from "k6/execution";
import http from "k6/http";
import {{ check, sleep }} from "k6";

const COLLECTION_VARIABLES = {variables_json};
const REQUESTS = {requests_json};
const REQUEST_EXEC_NAMES = {request_exec_names_json};

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

function allocateWeightedVus(requests, requestWeights, totalVus) {{
  if (totalVus < requests.length) {{
    return null;
  }}

  const allocations = Object.fromEntries(requests.map((request) => [request.id, 1]));
  let remainingVus = totalVus - requests.length;
  if (remainingVus === 0) {{
    return allocations;
  }}

  const totalWeight = requests.reduce(
    (sum, request) => sum + resolveRequestWeight(request, requestWeights),
    0,
  );
  const remainders = [];

  for (const request of requests) {{
    const desiredExtra = (resolveRequestWeight(request, requestWeights) / totalWeight) * remainingVus;
    const extraVus = Math.floor(desiredExtra);
    allocations[request.id] += extraVus;
    remainders.push({{
      requestId: request.id,
      remainder: desiredExtra - extraVus,
      weight: resolveRequestWeight(request, requestWeights),
    }});
  }}

  let allocatedExtras = requests.reduce((sum, request) => sum + allocations[request.id] - 1, 0);
  let leftoverVus = remainingVus - allocatedExtras;

  remainders.sort((left, right) =>
    right.remainder - left.remainder ||
    right.weight - left.weight ||
    left.requestId.localeCompare(right.requestId)
  );

  for (let index = 0; index < leftoverVus; index += 1) {{
    allocations[remainders[index].requestId] += 1;
  }}

  return allocations;
}}

function buildScenarioStages(rampUp, rampUpTime, duration, targetVus) {{
  if (rampUp === "staged") {{
    return [
      {{ duration: rampUpTime, target: Math.max(1, Math.ceil(targetVus / 2)) }},
      {{ duration: rampUpTime, target: targetVus }},
      {{ duration, target: targetVus }},
    ];
  }}

  return [
    {{ duration: rampUpTime, target: targetVus }},
    {{ duration, target: targetVus }},
  ];
}}

function buildWeightedScenarioOptions(vus, duration, rampUp, rampUpTime, thresholds) {{
  const requestWeights = parseRequestWeights();
  const runnableRequests = selectRunnableRequests(
    getSelectedRequests(),
    "weighted",
    requestWeights,
  );

  if (!runnableRequests.length) {{
    throw new Error("Weighted mix requires at least one selected request with a positive weight.");
  }}

  const allocations = allocateWeightedVus(runnableRequests, requestWeights, vus);
  if (!allocations) {{
    return null;
  }}

  const scenarios = {{}};
  for (const request of runnableRequests) {{
    const scenarioName = `weighted_${{request.id}}`;
    const targetVus = allocations[request.id];
    const scenario = {{
      exec: REQUEST_EXEC_NAMES[request.id],
      tags: {{
        request_id: request.id,
        request_name: request.name,
        traffic_mode: "weighted",
      }},
    }};

    if (rampUp === "instant") {{
      scenarios[scenarioName] = {{
        ...scenario,
        executor: "constant-vus",
        vus: targetVus,
        duration,
      }};
    }} else {{
      scenarios[scenarioName] = {{
        ...scenario,
        executor: "ramping-vus",
        stages: buildScenarioStages(rampUp, rampUpTime, duration, targetVus),
      }};
    }}
  }}

  return {{ scenarios, thresholds }};
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

  if (resolveTrafficMode() === "weighted") {{
    const weightedScenarioOptions = buildWeightedScenarioOptions(
      vus,
      duration,
      rampUp,
      rampUpTime,
      thresholds,
    );
    if (weightedScenarioOptions) {{
      return weightedScenarioOptions;
    }}
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

function buildWeightedSchedule(requests, requestWeights) {{
  const schedule = [];

  for (const request of requests) {{
    const weight = resolveRequestWeight(request, requestWeights);
    for (let index = 0; index < weight; index += 1) {{
      schedule.push(request);
    }}
  }}

  if (!schedule.length) {{
    throw new Error("Weighted mix requires at least one selected request with a positive weight.");
  }}

  return schedule;
}}

function pickWeightedRequest(schedule) {{
  const iterationIndex = Number(exec.scenario.iterationInTest || 0);
  return schedule[iterationIndex % schedule.length];
}}

function findRequestById(requestId) {{
  const request = REQUESTS.find((candidate) => candidate.id === requestId);
  if (!request) {{
    throw new Error(`Could not find request ${{requestId}} in the imported collection.`);
  }}

  return request;
}}

function executeRequest(request, context, trafficMode) {{
  const url = resolveUrl(request.url, context);
  const headers = resolveHeaders(request.headers, context);
  const payload = request.body ? resolveTemplate(request.body, context) : undefined;
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

function executeRequestById(requestId, trafficMode) {{
  executeRequest(findRequestById(requestId), buildContext(), trafficMode);
  sleep(1);
}}

{request_exec_functions}

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
    executeRequest(pickWeightedRequest(weightedSchedule), context, trafficMode);
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
        request_exec_names_json = request_exec_names_json,
        request_exec_functions = request_exec_functions,
        collection_name = parsed.name,
    ))
}
