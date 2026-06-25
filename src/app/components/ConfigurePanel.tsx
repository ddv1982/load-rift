import { TestHarnessConfigurePanel } from "./TestHarnessConfigurePanel";
import type {
  TestHarnessActionsProps,
  TestHarnessControlsProps,
  TestHarnessStatusProps,
} from "./TestHarnessSection.types";

interface ConfigurePanelProps {
  workflowTabsId: string;
  isActive: boolean;
  status: TestHarnessStatusProps;
  controls: TestHarnessControlsProps;
  actions: TestHarnessActionsProps;
}

export function ConfigurePanel({
  workflowTabsId,
  isActive,
  status,
  controls,
  actions,
}: ConfigurePanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${workflowTabsId}-configure-panel`}
      aria-labelledby={`${workflowTabsId}-configure-tab`}
      hidden={!isActive}
    >
      {isActive ? (
        <TestHarnessConfigurePanel
          status={status}
          controls={controls}
          actions={actions}
        />
      ) : null}
    </div>
  );
}
