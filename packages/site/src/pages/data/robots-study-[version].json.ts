/**
 * The dataset of each run at its own address: /crawler/data/robots-study-<version>.json. The build
 * writes one file for each file in src/data/study, so the repository keeps one copy.
 */
import type { Study } from "../../lib/study.ts";
import { RUN_STUDIES } from "../../lib/run-files.ts";

export const getStaticPaths = (): Array<{
  params: { version: string };
  props: { study: Study };
}> =>
  Object.entries(RUN_STUDIES).map(([version, study]) => ({
    params: { version },
    props: { study },
  }));

export const GET = ({ props }: { readonly props: { readonly study: Study } }): Response =>
  new Response(JSON.stringify(props.study), { headers: { "Content-Type": "application/json" } });
