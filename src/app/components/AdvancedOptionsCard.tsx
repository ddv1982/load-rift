import { useId } from "react";
import type { AdvancedOptionsFeedback } from "../advancedOptions";
import { SettingsCardHeader } from "./SettingsCardHeader";

interface AdvancedOptionsCardProps {
  value: string;
  feedback: AdvancedOptionsFeedback | null;
  onChange: (value: string) => void;
}

export function AdvancedOptionsCard({
  value,
  feedback,
  onChange,
}: AdvancedOptionsCardProps) {
  const feedbackId = useId();

  return (
    <div className="settings-card">
      <SettingsCardHeader
        eyebrow="Advanced"
        title="Raw k6 Options JSON"
        hint="Optional. This JSON is merged over the basic settings so you can define scenarios, tags, thresholds, and other k6 options that do not fit the simple form. If you set scenarios, stages, or iterations here, the advanced load profile overrides the basic load controls."
      />

      <label className="field">
        <span>Advanced options JSON</span>
        <textarea
          value={value}
          aria-label="Advanced options JSON"
          onChange={(event) => onChange(event.target.value)}
          placeholder='{"scenarios":{"steady":{"executor":"constant-vus","vus":25,"duration":"2m"}}}'
          rows={8}
          aria-invalid={feedback?.tone === "error" ? "true" : undefined}
          aria-describedby={feedback ? feedbackId : undefined}
        />
        {feedback ? (
          <p
            id={feedbackId}
            className={`inline-note json-feedback${
              feedback.tone === "success" ? " is-success" : " is-error"
            }`}
            aria-live="polite"
          >
            {feedback.message}
          </p>
        ) : null}
      </label>
    </div>
  );
}
