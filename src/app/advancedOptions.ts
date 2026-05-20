export interface AdvancedOptionsFeedback {
  tone: "success" | "error";
  message: string;
}

export function getAdvancedOptionsFeedback(
  value: string,
): AdvancedOptionsFeedback | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmedValue) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return {
        tone: "error",
        message: "Advanced options must be a JSON object.",
      };
    }

    return { tone: "success", message: "JSON syntax looks valid." };
  } catch (error) {
    return {
      tone: "error",
      message: `Invalid JSON: ${error instanceof Error ? error.message : "Unable to parse."}`,
    };
  }
}
