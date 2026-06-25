import { TestHarnessConfigurePanel } from "./TestHarnessConfigurePanel";
import { TestHarnessRunPanel } from "./TestHarnessRunPanel";
import type {
  TestHarnessActionsProps,
  TestHarnessControlsProps,
  TestHarnessStatusProps,
} from "./TestHarnessSection.types";

interface TestHarnessSectionProps {
  status: TestHarnessStatusProps;
  controls: TestHarnessControlsProps;
  actions: TestHarnessActionsProps;
  activeStep: "configure" | "run";
}

export function TestHarnessSection({
  status,
  controls,
  actions,
  activeStep,
}: TestHarnessSectionProps) {
  if (activeStep === "configure") {
    return (
      <TestHarnessConfigurePanel
        status={status}
        controls={controls}
        actions={actions}
      />
    );
  }

  return (
    <TestHarnessRunPanel status={status} controls={controls} actions={actions} />
  );
}
