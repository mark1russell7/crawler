/** A duration is a count of milliseconds, or a text, for example `"30m"`, `"24h"` or `"7d"`. */
export type Duration = number | string;

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * This function changes a duration into milliseconds. The units are `ms`, `s`, `m` (minutes), `h`,
 * `d` and `w`, in any case. The unit `M` is an error, because a month is not a unit. A bare `0`
 * is zero. The function throws an error for a text that it cannot read.
 */
export const durationMs = (duration: Duration): number => {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0)
      throw new Error(`not a duration: ${String(duration)}`);
    return duration;
  }
  if (/^\s*0+(\.0+)?\s*$/.test(duration)) return 0;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(duration);
  const unit = match?.[2];
  const factor = unit === undefined || unit === "M" ? undefined : UNITS[unit.toLowerCase()];
  if (match === null || factor === undefined) {
    throw new Error(
      `not a duration: "${duration}" (write a number and ms, s, m, h, d or w; m is minutes)`,
    );
  }
  return Number(match[1]) * factor;
};
