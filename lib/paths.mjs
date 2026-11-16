// Every file location in one place, resolved from the app's own folder so
// it works no matter which folder it is started from. Tests point the data
// and output folders at throwaway copies so they never touch real picks.

import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const fromEnv = (name, fallback) =>
  process.env[name] ? path.resolve(process.env[name]) : fallback;

// Your picks, lineup history, status, and backups.
export const DATA_DIR = fromEnv("EDGEBOARD_DATA_DIR", path.join(ROOT, "data"));
// The built pages.
export const OUT_DIR = fromEnv("EDGEBOARD_OUT_DIR", path.join(ROOT, "_site"));
// Downloaded ESPN responses. Holds no personal data, so test runs share it
// unless a test needs to simulate a brand-new copy with nothing downloaded.
export const CACHE_DIR = fromEnv("EDGEBOARD_CACHE_DIR", path.join(ROOT, ".cache"));
// Daily copies of your picks. Safe to point at a synced folder such as
// iCloud Drive or OneDrive, because these are finished copies, not the
// live database.
export const BACKUP_DIR = fromEnv("EDGEBOARD_BACKUP_DIR", path.join(DATA_DIR, "backups"));
// A clone of your private picks repository, for syncing between computers.
export const SYNC_DIR = fromEnv("EDGEBOARD_SYNC_DIR", path.join(DATA_DIR, "sync"));
