// Accessible styled switch. `danger` tints it red when on (used for the
// "hide the whale" tamper control).
export default function Toggle({
  on,
  onChange,
  label,
  danger,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`toggle${on ? " on" : ""}${danger ? " danger" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </button>
  );
}
