export function getTauriErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const message: unknown = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}
