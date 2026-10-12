/**
 * The dataset of the robots.txt study at a stable address: /crawler/data/robots-study.json. The build
 * writes the file from src/data, so the repository keeps one copy.
 */
import study from "../../data/robots-study.json";

export const GET = (): Response =>
  new Response(JSON.stringify(study), { headers: { "Content-Type": "application/json" } });
