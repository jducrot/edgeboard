// Loaded with --import to simulate a computer with no internet: every
// network request fails the way it does when there is no connection.
globalThis.fetch = async () => {
  throw new TypeError("fetch failed (simulated: no internet)");
};
