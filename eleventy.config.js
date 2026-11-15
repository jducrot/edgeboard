import { WORDMARK, wordmarkViolations } from "./lib/wordmark.mjs";

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "site/styles.css": "styles.css" });

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
