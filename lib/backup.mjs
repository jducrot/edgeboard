// Daily backups of the picks database. Uses SQLite's online backup, which
// produces a consistent copy even while the app is writing. Lineup history
// is not backed up: it can always be downloaded again.

import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db.mjs";
import { BACKUP_DIR } from "./paths.mjs";

const PREFIX = "edgeboard-picks-";

function todayStamp(now) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Make today's backup if it does not exist yet, then keep only the newest
 * `keep` backups. Returns the file written, or null if today's existed.
 */
export async function backupPicks({ keep = 14, now = new Date(), dir = BACKUP_DIR } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${PREFIX}${todayStamp(now)}.db`);
  let written = null;
  try {
    await fs.access(file);
  } catch {
    const tmp = `${file}.partial`;
    await getDb().backup(tmp);
    await fs.rename(tmp, file);
    written = file;
  }
  const backups = (await fs.readdir(dir))
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(".db"))
    .sort()
    .reverse();
  for (const old of backups.slice(keep)) await fs.unlink(path.join(dir, old));
  return written;
}
