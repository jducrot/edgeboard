import fs from "node:fs/promises";
import path from "node:path";
import { WORDMARK, wordmarkViolations } from "./lib/wordmark.mjs";

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "site/styles.css": "styles.css" });

  // Capitalize only the first letter. Nunjucks' own capitalize lowercases
  // the rest, which would break names and abbreviations.
  eleventyConfig.addFilter("upperFirst", (s) => (s ? s[0].toUpperCase() + s.slice(1) : s));

  // Fail the build if any page shows the name in any other form.
  eleventyConfig.addTransform("wordmark-guard", function (content) {
    const out = this.page.outputPath;
    if (typeof out !== "string" || !out.endsWith(".html")) return content;
    const wrong = wordmarkViolations(content);
    if (wrong.length > 0) {
      throw new Error(
        `Wordmark altered in ${out}: found ${wrong.map((w) => `"${w}"`).join(", ")}. It must always be "${WORDMARK}".`,
      );
    }
    return content;
  });

  // Eleventy never deletes pages it no longer writes, so slates for dates
  // that left the three-day window would stay reachable with stale data.
  // Remove dated slate folders this build did not write. A build that
  // wrote no slates at all removes nothing.
  eleventyConfig.on("eleventy.after", async ({ dir, results }) => {
    const written = new Set(
      results.map((r) => /^\/slate\/(\d{8})\/$/.exec(r.url ?? "")?.[1]).filter(Boolean),
    );
    if (written.size === 0) return;
    const slateDir = path.join(dir.output, "slate");
    const entries = await fs.readdir(slateDir).catch(() => []);
    for (const name of entries) {
      if (/^\d{8}$/.test(name) && !written.has(name)) {
        await fs.rm(path.join(slateDir, name), { recursive: true, force: true });
      }
    }
  });

  return {
    dir: {
      input: "site",
      includes: "_includes",
      data: "_data",
      // The server passes its own output folder; this is for direct builds.
      output: process.env.EDGEBOARD_OUT_DIR || "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
