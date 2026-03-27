export interface CurlImportState {
  status: "idle" | "ready" | "error";
  message: string | null;
}
