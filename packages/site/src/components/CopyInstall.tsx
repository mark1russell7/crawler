/** The install commands, with a button that copies each one. */
import { useState, type ReactElement } from "react";

const COMMANDS = [
  { label: "Library", command: "npm install polite-crawler" },
  { label: "Claude Code", command: "claude mcp add polite-crawler -- npx -y polite-crawler mcp" },
] as const;

/**
 * This function copies the text. It uses the clipboard API, and an older method when the browser
 * has no clipboard API. It gives false when neither method copies.
 */
const copy = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // the page has no permission: try the older method
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
};

/** The install lines. */
export default function CopyInstall(): ReactElement {
  const [state, setState] = useState<{ readonly command: string; readonly ok: boolean } | undefined>(undefined);
  return (
    <div className="pc-install">
      {COMMANDS.map(({ label, command }) => (
        <div className="pc-install-row" key={command}>
          <span className="pc-install-label">{label}</span>
          <code>{command}</code>
          <button
            type="button"
            className="pc-button"
            aria-label={`Copy the command for ${label}`}
            onClick={() => {
              void copy(command).then((ok) => {
                setState({ command, ok });
                if (ok) setTimeout(() => setState(undefined), 1500);
              });
            }}
          >
            {state?.command === command ? (state.ok ? "Copied" : "Not copied") : "Copy"}
          </button>
          <span className="pc-sr" aria-live="polite">
            {state?.command === command && state.ok ? `The command for ${label} is on the clipboard.` : ""}
          </span>
          {state?.command === command && !state.ok ? (
            <p className="pc-install-error" role="status">
              The browser did not let the page copy. Select the command and copy it.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
