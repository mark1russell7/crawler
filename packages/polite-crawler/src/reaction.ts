/**
 * The reaction of a host to one answer: the result that its counts get, its rest and its stops.
 * The `Crawler` and the send of `polite-crawler/api` use the same pure functions. This module is not
 * in `polite-crawler/politeness`, thus the size of that entry for a browser does not change.
 */
import type { Outcome } from "./classify.ts";
import { isClientError } from "./classify.ts";
import type { HostCounts, HostResult, HostStop, PolitenessPolicy } from "./politeness.ts";
import { MAX_STOP_MS, equalJitterMs } from "./politeness.ts";

/**
 * These are the facts of one answer that set the reaction of its host. `classify` gives the
 * outcome and the wait that the server asked for.
 *
 * @beta
 */
export interface OutcomeFacts {
  /** This value is the outcome of the answer. */
  readonly outcome: Outcome;
  /** This value is the status of the answer. The value 0 is a request with no answer. */
  readonly status: number;
  /** This value is the wait that the server asked for (`Retry-After`). */
  readonly retryAfterMs?: number | undefined;
  /**
   * A refusal (`blocked`) with one of these statuses does not stop the host. The crawler spares
   * 401 and 403 for robots.txt (RFC 9309). An API client spares a 401 before it gets a new token.
   */
  readonly spare?: readonly number[] | undefined;
  /** This result replaces the result of the outcome, and the host gets only its rest. A cancelled request is `neutral`. */
  readonly result?: HostResult | undefined;
}

/**
 * These values set the reaction to one answer.
 *
 * @beta
 */
export interface ReactionContext {
  /** This value is the policy of the host. */
  readonly policy: PolitenessPolicy;
  /** This value is the time of the answer, in milliseconds since the epoch. */
  readonly now: number;
  /** This value is the rest of the host that `restAfter` gives for the request. */
  readonly restMs: number;
  /** This function gives a number in [0, 1) for the jitter of a backoff. */
  readonly random: () => number;
}

/**
 * This value tells how one answer changes its host, after its counts changed.
 *
 * @beta
 */
export interface HostReaction {
  /** This value is the rest of the host before its next request, in milliseconds. */
  readonly restMs: number;
  /**
   * This value tells why the rest is longer than the rest of `restAfter`: a backoff, or the
   * `Retry-After` of the server. A longer rest parks the host.
   */
  readonly longer: "backoff" | "retry-after" | undefined;
  /** This value is the stop of the host, when the answer stops it. */
  readonly stop: HostStop | undefined;
}

/**
 * This function tells how one answer changes the counts of its host. Give the result to
 * `HostStateStore.record`. These are the rules:
 *
 * - A 429, 502, 503 or 504 is a wait.
 * - A different error and a request with no answer are failures. A client error (`isClientError`) is neutral.
 * - Each other outcome is a success. A refusal is a success too, because its stop is the reaction.
 *
 * @beta
 */
export const outcomeResult = (facts: OutcomeFacts): HostResult => {
  if (facts.result !== undefined) return facts.result;
  if (facts.outcome === "rate-limited" || facts.outcome === "unavailable") return "wait";
  if (facts.outcome === "error") return isClientError(facts.status) ? "neutral" : "failure";
  return "success";
};

/**
 * This function gives the reaction of a host to one answer, with the counts that `record` gave for
 * the result of `outcomeResult`. The `Crawler` and the send of `polite-crawler/api` use it. These
 * are the rules, with the times of the policy:
 *
 * - A 429, 502, 503 or 504 parks the host for its `Retry-After`, or for a backoff with jitter. A
 *   `Retry-After` longer than `maxRetryAfterMs` stops the host for that time, up to 30 days.
 * - A failure parks the host for a backoff with jitter. After `maxFailures` failures in sequence, the host also stops.
 * - A 401 or a 403 stops the host for `blockedStopMs`. A 402 and a bot challenge stop it longer.
 * - Each other answer gives the rest of `restAfter`.
 *
 * The function is pure, so a simulation and a study can use the reactions of the crawler.
 *
 * @beta
 */
export const reactToOutcome = (
  facts: OutcomeFacts,
  counts: HostCounts,
  context: ReactionContext,
): HostReaction => {
  const { policy, now, restMs, random } = context;
  const rest: HostReaction = { restMs, longer: undefined, stop: undefined };
  // only a rest longer than the pace has a reason
  const longer = (ms: number, reason: "backoff" | "retry-after"): HostReaction =>
    ms > restMs ? { restMs: ms, longer: reason, stop: undefined } : rest;
  const stop = (ms: number, reason: string): HostReaction => ({
    ...rest,
    stop: { until: now + ms, reason },
  });
  if (facts.result !== undefined) return rest;
  switch (facts.outcome) {
    case "rate-limited":
    case "unavailable": {
      const asked = facts.retryAfterMs;
      // a wait longer than the budget stops the host, so no request sleeps for days
      if (asked !== undefined && asked > policy.maxRetryAfterMs)
        return stop(
          Math.min(asked, MAX_STOP_MS),
          `asked to wait ${String(Math.round(asked / 1000))} s`,
        );
      return asked === undefined
        ? longer(
            equalJitterMs(counts.waits, policy.backoffBaseMs, policy.backoffCapMs, random),
            "backoff",
          )
        : longer(asked, "retry-after");
    }
    case "error": {
      if (isClientError(facts.status)) return rest;
      const backoff = longer(
        equalJitterMs(counts.failures, policy.backoffBaseMs, policy.backoffCapMs, random),
        "backoff",
      );
      if (counts.failures < policy.maxFailures) return backoff;
      return {
        ...backoff,
        stop: {
          until: now + policy.failureStopMs,
          reason: `${String(counts.failures)} failures in a row`,
        },
      };
    }
    case "challenge":
      return stop(policy.challengeStopMs, "challenge");
    case "payment-required":
      return stop(policy.paymentStopMs, "payment-required");
    case "blocked":
      return facts.spare?.includes(facts.status) === true
        ? rest
        : stop(policy.blockedStopMs, "blocked");
    default:
      return rest;
  }
};
