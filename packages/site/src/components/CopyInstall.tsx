/** The install commands, with a button that copies each one. */
import { useState, type ReactElement } from "react";

const COMMANDS = [
  { label: "Library", command: "npm install polite-crawler" },
  { label: "Claude Code", command: "claude mcp add polite-crawler -- npx -y polite-crawler mcp" },
] as const;

/** The install lines. */
export default function CopyInstall(): ReactElement {
  const [copied, setCopied] = useState<string | undefined>(undefined);
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
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(command);
                setTimeout(() => setCopied(undefined), 1500);
              });
            }}
          >
            {copied === command ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
    </div>
  );
}
