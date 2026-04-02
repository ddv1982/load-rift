interface SettingsCardHeaderProps {
  eyebrow: string;
  title: string;
  hint: string;
}

export function SettingsCardHeader({
  eyebrow,
  title,
  hint,
}: SettingsCardHeaderProps) {
  return (
    <div className="settings-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
      </div>
      <p className="field-hint">{hint}</p>
    </div>
  );
}
