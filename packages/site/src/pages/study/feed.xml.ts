/**
 * The file /crawler/study/feed.xml: the RSS 2.0 feed of the robots.txt study, with one item for each
 * monthly run. The build writes it from the history of the runs.
 */
import history from "../../data/study-history.json";
import studyDoi from "../../data/study-doi.json";
import type { StudyDoi } from "../../lib/cite.ts";
import { conceptOf } from "../../lib/cite.ts";
import { studyFeed } from "../../lib/feed.ts";
import { RUN_CSV_BYTES } from "../../lib/run-files.ts";
import type { StudyHistory } from "../../lib/runs.ts";

export const GET = (): Response =>
  new Response(
    studyFeed(history as unknown as StudyHistory, RUN_CSV_BYTES, conceptOf(studyDoi as StudyDoi)),
    { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
  );
