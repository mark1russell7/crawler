import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // seoTitle: the title in search results, when it differs from the heading of the page
    schema: docsSchema({ extend: z.object({ seoTitle: z.string().optional() }) }),
  }),
};
