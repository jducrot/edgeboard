// Runs before `npm run dev`, `npm start`, and `npm test`, and is the first
// import in server.mjs, so it also guards `node server.mjs`. Uses no
// dependencies, so it works even when installed packages do not match.
// EDGEBOARD_MIN_NODE exists only so the tests can simulate an old Node.
const MIN_MAJOR = Number(process.env.EDGEBOARD_MIN_NODE) || 22;
const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_MAJOR) {
  console.error(`
EdgeBoard needs Node ${MIN_MAJOR} or newer. This computer is running Node ${process.versions.node}.

Older Node versions can crash with "segmentation fault" because the
database driver does not support them. To fix it:

  1. Install Node ${MIN_MAJOR} (with nvm: nvm install ${MIN_MAJOR}, or the LTS installer from nodejs.org)
  2. Reinstall packages so the database driver matches: delete node_modules, then run npm install
  3. Run npm run dev again
`);
  process.exit(1);
}
