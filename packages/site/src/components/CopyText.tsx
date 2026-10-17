/** A short text that a reader can select, with a button that copies it, and an optional link. */
import { useState, type ReactElement } from "react";
import { copy } from "../lib/clipboard.ts";

interface Props {
  readonly text: string;
  /** This text names the text for the label of the button, for example `the press address`. */
  readonly label: string;
  /** This address is the link after the button, for example a `mailto:` address. */
  readonly href?: string | undefined;
  /** This text is the text of the link. */
  readonly linkText?: string | undefined;
}

/** The text, the copy button and the link. */
export default function CopyText({ text, label, href, linkText }: Props): ReactElement {
  const [copied, setCopied] = useState<boolean | undefined>(undefined);
  return (
    <div className="pc-copy not-content">
      <code className="pc-copy-text">{text}</code>
      <button
        type="button"
        className="pc-button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copy(text).then((ok) => {
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(undefined), 1500);
          });
        }}
      >
        {copied === undefined ? "Copy" : copied ? "Copied" : "Not copied"}
      </button>
      {href === undefined ? null : <a href={href}>{linkText ?? href}</a>}
      <span className="pc-sr" aria-live="polite">
        {copied === true
          ? `${label.charAt(0).toUpperCase()}${label.slice(1)} is on the clipboard.`
          : ""}
      </span>
      {copied === false ? (
        <p className="pc-copy-error" role="status">
          The browser did not let the page copy. Select the text and copy it.
        </p>
      ) : null}
    </div>
  );
}
