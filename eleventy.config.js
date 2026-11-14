export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "site/styles.css": "styles.css" });

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
