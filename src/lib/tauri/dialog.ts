import { open, save } from "@tauri-apps/plugin-dialog";

export async function selectCollectionFile(): Promise<string | null> {
  try {
    const selected = await open({
      title: "Select Postman Collection",
      multiple: false,
      filters: [
        {
          name: "JSON",
          extensions: ["json"],
        },
      ],
    });

    return typeof selected === "string" ? selected : null;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Failed to open the collection file picker: ${error.message}`
        : "Failed to open the collection file picker.",
    );
  }
}

export async function selectReportSavePath(
  defaultPath = "loadrift-report.html",
): Promise<string | null> {
  try {
    const selected = await save({
      title: "Save Load Rift Report",
      defaultPath,
      filters: [
        {
          name: "HTML",
          extensions: ["html"],
        },
      ],
    });

    return typeof selected === "string" ? selected : null;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Failed to open the report save dialog: ${error.message}`
        : "Failed to open the report save dialog.",
    );
  }
}
