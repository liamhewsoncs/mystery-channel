const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const chokidar = require("chokidar");
const { isVideoFile, parseEpisode, cleanTitle } = require("./episode-parser.cjs");

const SKIP_DIRECTORIES = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules"]);
const EPISODE_CONTAINER = /^(?:(?:season|series)[ ._-]*\d+|specials?|episodes?)$/i;

async function walkVideos(directory) {
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walkVideos(fullPath));
    else if (entry.isFile() && isVideoFile(fullPath)) results.push(fullPath);
  }
  return results;
}

async function quickFingerprint(filePath, stat) {
  const blockSize = Math.min(64 * 1024, stat.size);
  const first = Buffer.alloc(blockSize);
  const last = stat.size > blockSize ? Buffer.alloc(blockSize) : Buffer.alloc(0);
  const handle = await fsp.open(filePath, "r");
  try {
    if (blockSize) await handle.read(first, 0, blockSize, 0);
    if (last.length) await handle.read(last, 0, blockSize, Math.max(0, stat.size - blockSize));
  } finally {
    await handle.close();
  }
  return `${stat.size}:${crypto.createHash("sha1").update(first).update(last).digest("hex")}`;
}

function displayNameFromFolder(folderPath) {
  return cleanTitle(path.basename(folderPath).replace(/\s*[\[(](?:19|20)\d{2}[\])]?\s*$/, "")) || path.basename(folderPath);
}

class LibraryScanner {
  constructor(database, onChanged = () => {}) {
    this.database = database;
    this.onChanged = onChanged;
    this.watcher = null;
    this.scanPromise = null;
    this.debounceTimer = null;
  }

  async scanAll() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async performScan() {
    let programCount = 0;
    let episodeCount = 0;
    for (const folder of this.database.getLibraryFolders()) {
      const result = await this.scanFolder(folder);
      programCount += result.programs;
      episodeCount += result.episodes;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.onChanged({ programs: programCount, episodes: episodeCount });
    return { programs: programCount, episodes: episodeCount };
  }

  async scanFolder(folder) {
    this.database.startFolderScan(folder.id);
    let entries;
    try {
      entries = await fsp.readdir(folder.path, { withFileTypes: true });
    } catch {
      return { programs: 0, episodes: 0 };
    }

    const programSources = [];
    const rootVideos = entries
      .filter((entry) => entry.isFile() && isVideoFile(path.join(folder.path, entry.name)))
      .map((entry) => path.join(folder.path, entry.name));
    const childSources = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      const programPath = path.join(folder.path, entry.name);
      const files = await walkVideos(programPath);
      if (files.length) childSources.push({ folderPath: programPath, files, isEpisodeContainer: EPISODE_CONTAINER.test(entry.name) });
    }

    const episodeContainers = childSources.filter((source) => source.isEpisodeContainer);
    const programmeFolders = childSources.filter((source) => !source.isEpisodeContainer);
    if (rootVideos.length || episodeContainers.length) {
      programSources.push({
        folderPath: folder.path,
        files: [...rootVideos, ...episodeContainers.flatMap((source) => source.files)]
      });
    }
    programSources.push(...programmeFolders);

    let episodes = 0;
    for (const source of programSources) {
      const fileItems = [];
      for (const filePath of source.files) {
        try {
          const stat = await fsp.stat(filePath);
          const fingerprint = await quickFingerprint(filePath, stat);
          fileItems.push({ filePath, stat, fingerprint });
        } catch {
          // A file can disappear while a watched folder is being scanned.
        }
        if (fileItems.length % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      const program = this.database.upsertProgram(
        folder.id,
        source.folderPath,
        displayNameFromFolder(source.folderPath),
        fileItems.map((item) => item.fingerprint)
      );
      for (const item of fileItems) {
        const parsed = parseEpisode(item.filePath);
        this.database.upsertEpisode(program.id, {
          ...parsed,
          filePath: item.filePath,
          fileSize: item.stat.size,
          fingerprint: item.fingerprint
        });
        episodes += 1;
      }
    }
    return { programs: programSources.length, episodes };
  }

  async restartWatcher() {
    if (this.watcher) await this.watcher.close();
    const paths = this.database.getLibraryFolders().map((folder) => folder.path).filter(fs.existsSync);
    if (!paths.length) {
      this.watcher = null;
      return;
    }
    this.watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      ignored: (watchPath) => path.basename(watchPath).startsWith(".")
    });
    this.watcher.on("all", (_eventName, changedPath) => {
      if (changedPath && !isVideoFile(changedPath) && path.extname(changedPath)) return;
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.scanAll().catch(() => {}), 1200);
    });
  }

  async close() {
    clearTimeout(this.debounceTimer);
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    if (this.scanPromise) await this.scanPromise.catch(() => {});
  }
}

module.exports = { LibraryScanner, walkVideos, quickFingerprint, displayNameFromFolder };
