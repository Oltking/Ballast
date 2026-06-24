import { useState } from "react";

// Inline copy-to-clipboard chip for contract ids / hashes. Shows the text
// (monospace) plus a copy button that flips to a check on success.
export default function CopyId({
  value,
  display,
}: {
  value: string;
  display?: string;
}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      window.setTimeout(() => setDone(false), 1300);
    } catch {
      /* clipboard blocked — no-op */
    }
  }
  return (
    <button className={`copyid${done ? " done" : ""}`} onClick={copy} title="Copy">
      <span className="copyid-text mono">{display ?? value}</span>
      <span className="copyid-icon">{done ? "✓" : "⧉"}</span>
    </button>
  );
}
