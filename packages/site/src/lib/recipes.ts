/**
 * The robots.txt of the recipe "Block AI training crawlers, let AI assistants in". The page of the
 * recipe shows it, and the robots.txt tester has it as an example. Thus the two always agree.
 */
export const TRAINING_BLOCK_ROBOTS = `# Crawlers and tokens for the training of AI models: no pages
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: meta-externalagent
Disallow: /

# Assistants that fetch a page because a person asked for it
User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
Disallow: /account/
Allow: /

# Crawlers for AI search: they show the site in answers, with a link
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
Disallow: /account/
Allow: /

# All other crawlers, for example Googlebot
User-agent: *
Disallow: /account/
Content-Signal: search=yes, ai-input=yes, ai-train=no

Sitemap: https://www.example.com/sitemap.xml
`;

/** The paths that show what the recipe does. */
export const TRAINING_BLOCK_PATHS = "/\n/blog/a-post\n/account/orders";
