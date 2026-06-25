export interface ParsedCurlBody {
  value: string;
  sourceFlag: string;
}

export interface ParsedCurlCommand {
  method: string | null;
  url: string | null;
  baseUrl: string | null;
  headers: Record<string, string>;
  authToken: string | null;
  body: ParsedCurlBody | null;
}

export function normalizeBearerTokenInput(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.toLowerCase().startsWith("authorization:")) {
    normalized = normalized.slice("authorization:".length).trim();
  }

  const bearerMatch = normalized.match(/^bearer\s+(.+)$/i);
  if (bearerMatch) {
    normalized = bearerMatch[1]?.trim() ?? "";
  }

  return normalized || null;
}

export function parseCurlCommand(command: string): ParsedCurlCommand {
  const tokens = tokenizeShellWords(command);
  const headers: Record<string, string> = {};
  const bodyParts: string[] = [];
  let url: string | null = null;
  let method: string | null = null;
  let authToken: string | null = null;
  let bodySourceFlag: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token === "curl") {
      continue;
    }

    const headerValue = valueForFlag(tokens, index, ["-H", "--header"]);
    if (headerValue) {
      const rawHeader = headerValue.value;
      if (!rawHeader) {
        continue;
      }

      const separatorIndex = rawHeader.indexOf(":");
      if (separatorIndex > 0) {
        const key = rawHeader.slice(0, separatorIndex).trim();
        const value = rawHeader.slice(separatorIndex + 1).trim();
        if (key) {
          headers[key] = value;
        }
        if (key.toLowerCase() === "authorization") {
          authToken = normalizeAuthorizationHeaderToken(value);
        }
      }
      index += headerValue.consumed;
      continue;
    }

    const methodValue = valueForFlag(tokens, index, ["-X", "--request"]);
    if (methodValue) {
      method = methodValue.value.toUpperCase();
      index += methodValue.consumed;
      continue;
    }

    const dataValue = valueForFlag(tokens, index, [
      "-d",
      "--data",
      "--data-raw",
      "--data-binary",
      "--data-ascii",
      "--data-urlencode",
    ]);
    if (dataValue) {
      bodyParts.push(dataValue.value);
      bodySourceFlag = dataValue.flag;
      if (!method) {
        method = "POST";
      }
      index += dataValue.consumed;
      continue;
    }

    const jsonValue = valueForFlag(tokens, index, ["--json"]);
    if (jsonValue) {
      bodyParts.push(jsonValue.value);
      bodySourceFlag = jsonValue.flag;
      headers["Content-Type"] ??= "application/json";
      headers["Accept"] ??= "application/json";
      if (!method) {
        method = "POST";
      }
      index += jsonValue.consumed;
      continue;
    }

    const urlValue = valueForFlag(tokens, index, ["--url"]);
    if (urlValue) {
      if (looksLikeUrl(urlValue.value)) {
        url = urlValue.value;
      }
      index += urlValue.consumed;
      continue;
    }

    if (!url && looksLikeUrl(token)) {
      url = token;
    }
  }

  let baseUrl: string | null = null;
  if (url) {
    try {
      baseUrl = new URL(url).origin;
    } catch {
      baseUrl = null;
    }
  }

  return {
    method,
    url,
    baseUrl,
    headers,
    authToken,
    body: bodyParts.length
      ? {
          value: bodyParts.join("&"),
          sourceFlag: bodySourceFlag ?? "--data",
        }
      : null,
  };
}

function normalizeAuthorizationHeaderToken(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const bearerMatch = normalized.match(/^bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1]?.trim() || null;
  }

  const schemeMatch = normalized.match(/^[A-Za-z][A-Za-z0-9._-]*\s+\S+/);
  if (schemeMatch) {
    return null;
  }

  return normalized;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

interface FlagValue {
  flag: string;
  value: string;
  consumed: number;
}

function valueForFlag(
  tokens: string[],
  index: number,
  flags: string[],
): FlagValue | null {
  const token = tokens[index];
  if (!token) {
    return null;
  }

  for (const flag of flags) {
    if (token === flag && index + 1 < tokens.length) {
      return {
        flag,
        value: tokens[index + 1] ?? "",
        consumed: 1,
      };
    }

    if (token.startsWith(`${flag}=`)) {
      return {
        flag,
        value: token.slice(flag.length + 1),
        consumed: 0,
      };
    }

    if (
      flag.length === 2 &&
      flag.startsWith("-") &&
      !flag.startsWith("--") &&
      token.startsWith(flag) &&
      token.length > flag.length
    ) {
      return {
        flag,
        value: token.slice(flag.length),
        consumed: 0,
      };
    }
  }

  return null;
}

function tokenizeShellWords(input: string): string[] {
  const normalizedInput = input.replace(/\\\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < normalizedInput.length; index += 1) {
    const character = normalizedInput[index];
    if (character === undefined) {
      continue;
    }

    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        index += 1;
        current += normalizedInput[index] ?? "";
      } else {
        current += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "\\") {
      index += 1;
      current += normalizedInput[index] ?? "";
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
