export type WorkflowStep = "source" | "configure" | "run";

export const workflowSteps: WorkflowStep[] = ["source", "configure", "run"];

export function getWorkflowStepLabel(step: WorkflowStep) {
  if (step === "source") {
    return "Source";
  }

  if (step === "configure") {
    return "Configure";
  }

  return "Run";
}
