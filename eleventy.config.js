// The wordmark is exactly "EdgeBoard". It is never altered in any way:
// not lowercased, not uppercased, not spaced, not restyled.
const WORDMARK = "EdgeBoard";
const ANY_SPELLING = /e\s*d\s*g\s*e[\s_-]*b\s*o\s*a\s*r\s*d/gi;

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "site/styles.css": "styles.css" });

  // Fail the build if any page shows the name in any other form.
  eleventyConfig.addTransform("wordmark-guard", function (content) {
    const out = this.page.outputPath;
    if (typeof out !== "string" || !out.endsWith(".html")) return content;
    const wrong = (content.match(ANY_SPELLING) ?? []).filter((m) => m !== WORDMARK);
    if (wrong.length > 0) {
      throw new Error(
        `Wordmark altered in ${out}: found ${[...new Set(wrong)].map((w) => `"${w}"`).join(", ")}. It must always be "${WORDMARK}".`,
      );
    }
    return content;
  });

  return {
    dir: {
      input: "site",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
