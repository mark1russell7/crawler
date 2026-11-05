/**
 * The data stamps at a stable address, for the freshness gate of the Pages workflow. The build writes the
 * file from the data files, so no person types a date or a version.
 */
import { studyLimitStamps, studyStamps } from "../lib/data-stamps.ts";

export const GET = (): Response =>
  new Response(
    JSON.stringify(
      { schema: "data-stamp/1", pages: [...studyStamps(), ...studyLimitStamps()] },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
