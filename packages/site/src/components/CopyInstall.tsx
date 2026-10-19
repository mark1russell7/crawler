/** The install commands, with a button that copies each one. */
import { Fragment, useState, type ReactElement } from "react";
import { copy } from "../lib/clipboard.ts";

const COMMANDS = [
  { label: "Library", command: "npm install polite-crawler" },
  { label: "Claude Code", command: "claude mcp add polite-crawler -- npx -y polite-crawler-mcp" },
] as const;

/** The install lines. */
export default function CopyInstall(): ReactElement {
  const [state, setState] = useState<
    { readonly command: string; readonly ok: boolean } | undefined
  >(undefined);
  return (
    <div className="pc-install">
      {COMMANDS.map(({ label, command }) => (
        <div className="pc-install-row" key={command}>
          <span className="pc-install-label">{label}</span>
          {/* the command wraps only between its words, never inside "-y" */}
          <code>
            {command.split(" ").map((word, index) => (
              <Fragment key={index}>
                {index > 0 ? " " : null}
                <span className="pc-install-word">{word}</span>
              </Fragment>
            ))}
          </code>
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
            {state?.command === command && state.ok
              ? `The command for ${label} is on the clipboard.`
              : ""}
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
