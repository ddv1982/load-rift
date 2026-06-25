import type { KeyboardEvent } from "react";
import {
  getWorkflowStepLabel,
  workflowSteps,
  type WorkflowStep,
} from "../workflow";

interface WorkflowStepperProps {
  activeWorkflowStep: WorkflowStep;
  workflowTabsId: string;
  tabRefs: {
    current: Array<HTMLButtonElement | null>;
  };
  onStepChange: (step: WorkflowStep) => void;
}

export function WorkflowStepper({
  activeWorkflowStep,
  workflowTabsId,
  tabRefs,
  onStepChange,
}: WorkflowStepperProps) {
  const activeWorkflowIndex = workflowSteps.indexOf(activeWorkflowStep);

  function focusWorkflowTab(index: number) {
    tabRefs.current[index]?.focus();
  }

  function handleWorkflowTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % workflowSteps.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + workflowSteps.length) % workflowSteps.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = workflowSteps.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextStep = workflowSteps[nextIndex];
    if (!nextStep) {
      return;
    }

    onStepChange(nextStep);
    focusWorkflowTab(nextIndex);
  }

  return (
    <nav className="workflow-stepper" aria-label="Load test workflow">
      <div className="workflow-step-tabs" role="tablist" aria-label="Workflow steps">
        {workflowSteps.map((step, index) => {
          const isActive = activeWorkflowStep === step;
          const tabId = `${workflowTabsId}-${step}-tab`;
          const panelId = `${workflowTabsId}-${step}-panel`;

          return (
            <button
              key={step}
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
              onClick={() => onStepChange(step)}
              onKeyDown={(event) => handleWorkflowTabKeyDown(event, index)}
            >
              <span className="workflow-step-index">{index + 1}</span>
              <span>{getWorkflowStepLabel(step)}</span>
            </button>
          );
        })}
      </div>
      <p className="workflow-step-status">
        Step {activeWorkflowIndex + 1} of {workflowSteps.length}
      </p>
    </nav>
  );
}
