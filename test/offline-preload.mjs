// Loaded with --import to simulate network trouble. By default every
// request fails the way it does when there is no connection. With
// EDGEBOARD_TEST_FAIL_URLS set to a pattern, only matching addresses fail.
// With EDGEBOARD_TEST_SLOW_URLS, matching addresses answer after
// EDGEBOARD_TEST_SLOW_MS (default 2000), and everything else works.
const pattern = (name) => (process.env[name] ? new RegExp(process.env[name]) : null);
const fail = pattern("EDGEBOARD_TEST_FAIL_URLS");
const slow = pattern("EDGEBOARD_TEST_SLOW_URLS");
const slowMs = Number(process.env.EDGEBOARD_TEST_SLOW_MS) || 2000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (slow && slow.test(url)) {
    await new Promise((r) => setTimeout(r, slowMs));
    return realFetch(input, init);
  }
  if (slow || (fail && !fail.test(url))) return realFetch(input, init);
  throw new TypeError("fetch failed (simulated: no internet)");
};
