export interface ParsedCurlCommand {
  url: string | null;
  baseUrl: string | null;
  authToken: string | null;
}

export function normalizeBearerTokenInput(value: string | null | undefined): string | null {
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
  let url: string | null = null;
  let authToken: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if ((token === "-H" || token === "--header") && index + 1 < tokens.length) {
      const rawHeader = tokens[index + 1];
      if (!rawHeader) {
        continue;
      }

      const separatorIndex = rawHeader.indexOf(":");
      if (separatorIndex > 0) {
        const key = rawHeader.slice(0, separatorIndex).trim();
        const value = rawHeader.slice(separatorIndex + 1).trim();
        if (key.toLowerCase() === "authorization") {
          authToken = normalizeBearerTokenInput(value);
        }
      }
      index += 1;
      continue;
    }

    if ((token === "--url" || token === "--location" || token === "-L") && index + 1 < tokens.length) {
      const candidate = tokens[index + 1];
      if (candidate && looksLikeUrl(candidate)) {
        url = candidate;
      }
      if (token === "--url") {
        index += 1;
      }
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
    url,
    baseUrl,
    authToken,
  };
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
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
