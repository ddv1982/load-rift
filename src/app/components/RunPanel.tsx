import { TestHarnessRunPanel } from "./TestHarnessRunPanel";
import type {
  TestHarnessActionsProps,
  TestHarnessControlsProps,
  TestHarnessStatusProps,
} from "./TestHarnessSection.types";

interface RunPanelProps {
  workflowTabsId: string;
  isActive: boolean;
  status: TestHarnessStatusProps;
  controls: TestHarnessControlsProps;
  actions: TestHarnessActionsProps;
}

export function RunPanel({
  workflowTabsId,
  isActive,
  status,
  controls,
  actions,
}: RunPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${workflowTabsId}-run-panel`}
      aria-labelledby={`${workflowTabsId}-run-tab`}
      hidden={!isActive}
    >
      {isActive ? (
        <TestHarnessRunPanel
          status={status}
          controls={controls}
          actions={actions}
        />
      ) : null}
    </div>
  );
}
