import { Router } from 'express';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const router = Router();

// Browsing is confined to this directory and its descendants -- without a
// boundary, GET /api/fs/list?path=/etc would happily list any path the
// server process can read.
const BROWSE_ROOT = process.env.FS_BROWSE_ROOT || os.homedir();

function withinBrowseRoot(dir) {
  return dir === BROWSE_ROOT || dir.startsWith(BROWSE_ROOT + path.sep);
}

// GET /api/fs/list?path=/some/dir -- lists subdirectories of a server-side
// path for the folder-picker UI (a browser can't hand back a real absolute
// path from a native file input, so browsing happens server-side instead).
router.get('/list', async (req, res) => {
  const dir = req.query.path ? path.resolve(String(req.query.path)) : BROWSE_ROOT;
  if (!withinBrowseRoot(dir)) {
    return res.status(403).json({ error: `Outside the allowed browse root (${BROWSE_ROOT}): ${dir}` });
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(400).json({ error: `No such directory: ${dir}` });
    if (err.code === 'EACCES') return res.status(403).json({ error: `Permission denied: ${dir}` });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: `Not a directory: ${dir}` });
    return res.status(500).json({ error: err.message });
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  const parentInBounds = parent !== dir && withinBrowseRoot(parent);
  res.json({ path: dir, parent: parentInBounds ? parent : null, dirs });
});
