import { describe, expect, it } from "vitest";
import { afterRetry, durationText } from "./response.ts";

describe("the Retry-After of a response", () => {
  it("is a wait of the host up to one hour, and a stop of at most 30 days after that", () => {
    expect(afterRetry(undefined)).toMatchObject({ kind: "none", text: "none" });
    expect(afterRetry(120_000)).toEqual({ kind: "wait", label: "Wait from Retry-After", text: "120 s" });
    expect(afterRetry(3_600_000)).toMatchObject({ kind: "wait", text: "3600 s" });
    expect(afterRetry(2 * 3_600_000)).toMatchObject({ kind: "stop", label: "Stop from Retry-After" });
    expect(afterRetry(2 * 3_600_000).text.startsWith("the host stops for 2 hours.")).toBe(true);
    // the example of the review: a Retry-After of 99,999,999 seconds
    const huge = afterRetry(99_999_999_000);
    expect(huge.kind).toBe("stop");
    expect(huge.text).toBe("the host stops for 30 days. A wait of more than 1 hour is a stop, for 30 days at most.");
  });

  it("writes durations for a reader", () => {
    expect([45_000, 20 * 60_000, 5 * 3_600_000, 30 * 86_400_000, 3_600_000, 86_400_000].map(durationText)).toEqual([
      "45 s",
      "20 minutes",
      "5 hours",
      "30 days",
      "1 hour",
      "24 hours",
    ]);
  });
});
