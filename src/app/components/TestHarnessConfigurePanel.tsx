import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  loadHarnessTab,
  saveHarnessTab,
  type HarnessTab,
} from "../persistence";
import { AdvancedOptionsCard } from "./AdvancedOptionsCard";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { RuntimeVariablesCard } from "./RuntimeVariablesCard";
import type {
  TestHarnessActionsProps,
  TestHarnessControlsProps,
  TestHarnessStatusProps,
} from "./TestHarnessSection.types";

interface TestHarnessConfigurePanelProps {
  status: TestHarnessStatusProps;
  controls: TestHarnessControlsProps;
  actions: TestHarnessActionsProps;
}

const tabs: HarnessTab[] = ["controls", "variables", "advanced"];

function getTabLabel(tab: HarnessTab) {
  if (tab === "controls") {
    return "Controls";
  }

  if (tab === "variables") {
    return "Variables";
  }

  return "Advanced";
}

export function TestHarnessConfigurePanel({
  status,
  controls,
  actions,
}: TestHarnessConfigurePanelProps) {
  const {
    collection,
    configValidation,
    runnerOptionsAreValid,
    displayedTestStatus,
    displayedVerdict,
  } = status;
  const {
    runnerOptions,
    thresholdInputs,
    thresholdErrors,
    vusInput,
    vusError,
    emptyRuntimeVariables,
    curlInput,
    curlImportState,
    advancedOptionsFeedback,
  } = controls;
  const {
    onVusChange,
    onDurationChange,
    onRampUpChange,
    onRampUpTimeChange,
    onThresholdChange,
    onTrafficModeChange,
    onAuthTokenChange,
    onBaseUrlChange,
    onRequestHeadersChange,
    onRequestBodyOverrideChange,
    onCurlInputChange,
    onApplyCurlCommand,
    onRuntimeVariableChange,
    onAdvancedOptionsChange,
  } = actions;
  const tabListId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeTab, setActiveTab] = useState<HarnessTab>(() =>
    loadHarnessTab("controls"),
  );
  const validationBanner = !runnerOptionsAreValid
    ? {
        status: "invalid" as const,
        message:
          "Fix the highlighted runner inputs before checking configuration or starting.",
      }
    : configValidation.status === "idle"
      ? null
      : configValidation;

  useEffect(() => {
    saveHarnessTab(activeTab);
  }, [activeTab]);

  function focusTab(index: number) {
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) {
      return;
    }

    setActiveTab(nextTab);
    focusTab(nextIndex);
  }

  return (
    <section
      className={`panel harness-panel workflow-panel configure-panel${
        collection ? " is-current" : " is-locked"
      }`}
    >
      <div className="section-heading section-heading-wide">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 2 · Configure</p>
          <h2>Configure the run</h2>
          <p className="section-copy">
            Set the load profile, target, variables, and k6 overrides.
          </p>
        </div>

        <div className="harness-heading-meta">
          <span className={`status-pill is-${displayedTestStatus}`}>
            {displayedVerdict}
          </span>
          <p className="panel-copy">
            {collection
              ? "Ready once required inputs are valid."
              : "Import a collection to configure."}
          </p>
        </div>
      </div>

      <div className="harness-main">
        {validationBanner ? (
          <div
            role={validationBanner.status === "invalid" ? "alert" : "status"}
            aria-live={
              validationBanner.status === "invalid" ? "assertive" : "polite"
            }
            aria-atomic="true"
            className={`validation-banner${
              validationBanner.status === "ready"
                ? " is-ready"
                : validationBanner.status === "invalid"
                  ? " is-invalid"
                  : ""
            }`}
          >
            <strong>Configuration Check</strong>
            <p>{validationBanner.message}</p>
          </div>
        ) : null}

        <div className="workflow-card workflow-card-primary">
          <div className="workflow-card-header">
            <div>
              <p className="eyebrow">Run profile</p>
              <h3>Primary controls</h3>
            </div>
            <p className="field-hint">
              Common settings first. Variables and JSON stay one click away.
            </p>
          </div>

          <div
            className="segmented-control segmented-control-compact"
            role="tablist"
            aria-label="Test harness controls"
          >
            {tabs.map((tab, index) => {
              const isActive = activeTab === tab;
              const tabId = `${tabListId}-${tab}-tab`;
              const panelId = `${tabListId}-${tab}-panel`;

              return (
                <button
                  key={tab}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={tabId}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  tabIndex={isActive ? 0 : -1}
                  className={isActive ? "is-active" : ""}
                  onClick={() => setActiveTab(tab)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {getTabLabel(tab)}
                </button>
              );
            })}
          </div>

          <div className="control-deck">
            <div
              role="tabpanel"
              id={`${tabListId}-controls-panel`}
              aria-labelledby={`${tabListId}-controls-tab`}
              hidden={activeTab !== "controls"}
            >
              <RunnerSettingsCard
                runnerOptions={runnerOptions}
                thresholdInputs={thresholdInputs}
                thresholdErrors={thresholdErrors}
                vusInput={vusInput}
                vusError={vusError}
                curlInput={curlInput}
                curlImportState={curlImportState}
                onVusChange={onVusChange}
                onDurationChange={onDurationChange}
                onRampUpChange={onRampUpChange}
                onRampUpTimeChange={onRampUpTimeChange}
                onThresholdChange={onThresholdChange}
                onTrafficModeChange={onTrafficModeChange}
                onAuthTokenChange={onAuthTokenChange}
                onBaseUrlChange={onBaseUrlChange}
                onRequestHeadersChange={onRequestHeadersChange}
                onRequestBodyOverrideChange={onRequestBodyOverrideChange}
                onCurlInputChange={onCurlInputChange}
                onApplyCurlCommand={onApplyCurlCommand}
              />
            </div>

            <div
              role="tabpanel"
              id={`${tabListId}-variables-panel`}
              aria-labelledby={`${tabListId}-variables-tab`}
              hidden={activeTab !== "variables"}
            >
              <RuntimeVariablesCard
                collection={collection}
                runnerOptions={runnerOptions}
                emptyRuntimeVariables={emptyRuntimeVariables}
                onRuntimeVariableChange={onRuntimeVariableChange}
              />
            </div>

            <div
              role="tabpanel"
              id={`${tabListId}-advanced-panel`}
              aria-labelledby={`${tabListId}-advanced-tab`}
              hidden={activeTab !== "advanced"}
            >
              <AdvancedOptionsCard
                value={runnerOptions.advancedOptionsJson ?? ""}
                feedback={advancedOptionsFeedback}
                onChange={onAdvancedOptionsChange}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
