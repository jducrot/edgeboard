// Coordinates page builds. Page loads join a build already running. Saves
// get a build that starts after the save, because a build already running
// may have read the data before the save and would show the page without it.

export function createBuildQueue(doBuild) {
  let building = null;
  let queued = null;

  /** Join the build in progress, or start one. */
  function rebuild() {
    if (building) return building;
    building = doBuild().finally(() => {
      building = null;
    });
    return building;
  }

  /** A build that starts after this call. Saves during one build share one follow-up. */
  function rebuildAfterChange() {
    if (!building) return rebuild();
    if (!queued) {
      queued = building
        .catch(() => {})
        .then(() => {
          queued = null;
          return rebuild();
        });
    }
    return queued;
  }

  return { rebuild, rebuildAfterChange, current: () => building };
}
