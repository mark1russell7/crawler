import { DEFAULT_POLICY, MAX_STOP_MS } from "polite-crawler/politeness";

/** This function writes a duration for a reader: "45 s", "20 minutes", "5 hours" or "30 days". */
export const durationText = (ms: number): string => {
  const unit = (count: number, name: string): string => `${String(count)} ${name}${count === 1 ? "" : "s"}`;
  if (ms < 120_000) return `${String(Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return unit(Math.round(ms / 60_000), "minute");
  if (ms < 2 * 86_400_000) return unit(Math.round(ms / 3_600_000), "hour");
  return unit(Math.round(ms / 86_400_000), "day");
};

/** This is what the crawler does with the `Retry-After` of a response. */
export interface AfterRetry {
  /** The value `stop` tells that the host stops: the wait is longer than the limit of the policy. */
  readonly kind: "none" | "wait" | "stop";
  readonly label: string;
  readonly text: string;
}

/**
 * This function tells what the crawler does with a `Retry-After`. A wait of 1 hour or less is a
 * wait of the host. A longer wait stops the host for the time that the server asks, and for 30
 * days at most. The limits come from the policy of the package.
 */
export const afterRetry = (retryAfterMs: number | undefined): AfterRetry => {
  if (retryAfterMs === undefined) return { kind: "none", label: "Wait from Retry-After", text: "none" };
  if (retryAfterMs <= DEFAULT_POLICY.maxRetryAfterMs) {
    return { kind: "wait", label: "Wait from Retry-After", text: `${String(Math.round(retryAfterMs / 1000))} s` };
  }
  const stop = durationText(Math.min(retryAfterMs, MAX_STOP_MS));
  return {
    kind: "stop",
    label: "Stop from Retry-After",
    text: `the host stops for ${stop}. A wait of more than ${durationText(DEFAULT_POLICY.maxRetryAfterMs)} is a stop, for ${durationText(MAX_STOP_MS)} at most.`,
  };
};
