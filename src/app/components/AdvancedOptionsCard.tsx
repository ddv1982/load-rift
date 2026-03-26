interface AdvancedOptionsCardProps {
  value: string;
  onChange: (value: string) => void;
}

export function AdvancedOptionsCard({
  value,
  onChange,
}: AdvancedOptionsCardProps) {
  return (
    <div className="settings-card">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">Advanced</p>
          <h3>Raw k6 Options JSON</h3>
        </div>
        <p className="field-hint">
          Optional. This JSON is merged over the basic settings so you can
          define scenarios, tags, thresholds, and other k6 options that do not
          fit the simple form.
        </p>
      </div>

      <label className="field">
        <span>Advanced options JSON</span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder='{"scenarios":{"steady":{"executor":"constant-vus","vus":25,"duration":"2m"}}}'
          rows={8}
        />
      </label>
    </div>
  );
}
