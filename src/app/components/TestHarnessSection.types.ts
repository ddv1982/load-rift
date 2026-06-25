import type { RefObject } from "react";
import type { ConfigValidationState } from "../../features/test/useConfigValidation";
import type { SmokeTestState } from "../../features/test/useSmokeTest";
import type { TestHarnessState } from "../../features/test/useTestHarness";
import type {
  CollectionInfo,
  K6Options,
  RuntimeVariable,
} from "../../lib/loadrift/types";
import type { AdvancedOptionsFeedback } from "../advancedOptions";
import type {
  ThresholdInputErrors,
  ThresholdInputValues,
} from "../hooks/useRunnerOptions";
import type { CurlImportState } from "../types";

export interface TestHarnessStatusProps {
  collection: CollectionInfo | null;
  testState: TestHarnessState;
  exportNotice: {
    tone: "error" | "success";
    message: string;
  } | null;
  configValidation: ConfigValidationState;
  canStartTest: boolean;
  canSmokeTest: boolean;
  runnerOptionsAreValid: boolean;
  displayedTestStatus: string;
  displayedVerdict: string;
  smokeTestState: SmokeTestState;
}

export interface TestHarnessControlsProps {
  runnerOptions: K6Options;
  thresholdInputs: ThresholdInputValues;
  thresholdErrors: ThresholdInputErrors;
  vusInput: string;
  vusError: string | null;
  emptyRuntimeVariables: RuntimeVariable[];
  curlInput: string;
  curlImportState: CurlImportState;
  advancedOptionsFeedback: AdvancedOptionsFeedback | null;
  eventLogRef: RefObject<HTMLPreElement | null>;
  resultSummaryRef: RefObject<HTMLDivElement | null>;
}

export interface TestHarnessActionsProps {
  onStartTest: () => void;
  onSmokeTest: () => void;
  onStopTest: () => void;
  onValidateConfiguration: () => void;
  onRefreshStatus: () => void;
  onExportLatestReport: () => void;
  onVusChange: (value: string) => void;
  onDurationChange: (value: string) => void;
  onRampUpChange: (value: K6Options["rampUp"]) => void;
  onRampUpTimeChange: (value: string) => void;
  onThresholdChange: (
    key: keyof K6Options["thresholds"],
    value: string,
  ) => void;
  onTrafficModeChange: (value: K6Options["trafficMode"]) => void;
  onAuthTokenChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onCurlInputChange: (value: string) => void;
  onApplyCurlCommand: () => void;
  onRuntimeVariableChange: (key: string, value: string) => void;
  onAdvancedOptionsChange: (value: string) => void;
}
