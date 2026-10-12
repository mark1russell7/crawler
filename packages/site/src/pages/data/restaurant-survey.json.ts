/**
 * The counts of the restaurant survey at a stable address: /crawler/data/restaurant-survey.json. The
 * file has counts only, and no site.
 */
import survey from "../../data/restaurant-survey.json";

export const GET = (): Response =>
  new Response(JSON.stringify(survey, null, 2), { headers: { "Content-Type": "application/json" } });
