const Database = require("better-sqlite3");
const path = require("node:path");

const DEFAULT_SETTINGS = {
  completionThreshold: 0.9,
  autoplay: true,
  avoidConsecutive: true,
  randomBalance: 0.7,
  organizerPattern: "{programme} - S{season}E{episode} - {title}"
};

class MysteryDatabase {
  static validateBackup(filePath) {
    const candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = candidate.pragma("integrity_check", { simple: true });
      if (String(integrity).toLocaleLowerCase() !== "ok") throw new Error(`Database integrity check failed: ${integrity}`);
      const requiredTables = ["settings", "library_folders", "programs", "episodes", "selection_history", "watch_events"];
      const tables = new Set(candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      const missingTables = requiredTables.filter((table) => !tables.has(table));
      if (missingTables.length) throw new Error(`Backup is missing required data: ${missingTables.join(", ")}`);
      const episodeColumns = new Set(candidate.pragma("table_info(episodes)").map((column) => column.name));
      for (const column of ["id", "program_id", "file_path", "sort_key", "completed", "available"]) {
        if (!episodeColumns.has(column)) throw new Error(`Backup has an incompatible episodes table (missing ${column}).`);
      }
      return true;
    } finally {
      candidate.close();
    }
  }

  constructor(filePath) {
    this.filePath = filePath;
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        excluded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER NOT NULL REFERENCES library_folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        folder_path TEXT NOT NULL COLLATE NOCASE,
        available INTEGER NOT NULL DEFAULT 1,
        excluded INTEGER NOT NULL DEFAULT 0,
        last_selected_at TEXT,
        selection_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_program_folder_path ON programs(folder_id, folder_path COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        file_fingerprint TEXT,
        file_size INTEGER NOT NULL DEFAULT 0,
        season_number INTEGER,
        episode_number INTEGER,
        air_date TEXT,
        title TEXT NOT NULL,
        sort_key TEXT NOT NULL,
        parse_confidence TEXT NOT NULL DEFAULT 'low',
        needs_review INTEGER NOT NULL DEFAULT 0,
        manual_override INTEGER NOT NULL DEFAULT 0,
        excluded INTEGER NOT NULL DEFAULT 0,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        last_played_at TEXT,
        available INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_episode_program_order ON episodes(program_id, completed, available, sort_key);
      CREATE INDEX IF NOT EXISTS idx_episode_fingerprint ON episodes(file_fingerprint);
      CREATE TABLE IF NOT EXISTS selection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS watch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        undone INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rename_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        old_path TEXT NOT NULL,
        new_path TEXT NOT NULL,
        confidence TEXT NOT NULL,
        collision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'preview',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS rename_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operations_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        undone INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
    const ensureColumn = (table, column, definition) => {
      const columns = this.db.pragma(`table_info(${table})`);
      if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensureColumn("library_folders", "active", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("library_folders", "excluded", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("programs", "excluded", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("episodes", "manual_override", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("episodes", "excluded", "INTEGER NOT NULL DEFAULT 0");
    const put = this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) put.run(key, JSON.stringify(value));
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  checkpoint() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  getSettings() {
    const result = { ...DEFAULT_SETTINGS };
    for (const row of this.db.prepare("SELECT key, value FROM settings").all()) {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
  }

  saveSettings(partial) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const put = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    const transaction = this.db.transaction((entries) => {
      for (const [key, value] of entries) put.run(key, JSON.stringify(value));
    });
    const entries = Object.entries(partial || {}).filter(([key]) => allowed.has(key));
    transaction(entries);
    return this.getSettings();
  }

  addLibraryFolder(folderPath) {
    const normalized = path.resolve(folderPath);
    this.db.prepare(`INSERT INTO library_folders(path) VALUES (?)
      ON CONFLICT(path) DO UPDATE SET active=1, excluded=0`).run(normalized);
    const row = this.db.prepare("SELECT id, path, excluded FROM library_folders WHERE path = ? COLLATE NOCASE").get(normalized);
    return { ...row, excluded: Boolean(row.excluded) };
  }

  getLibraryFolders() {
    return this.db.prepare("SELECT id, path, excluded FROM library_folders WHERE active=1 ORDER BY created_at, id").all()
      .map((row) => ({ ...row, excluded: Boolean(row.excluded) }));
  }

  setExcluded(kind, id, excluded) {
    const tables = { folder: "library_folders", program: "programs", episode: "episodes" };
    const table = tables[kind];
    if (!table) throw new Error("Unknown exclusion type.");
    const info = this.db.prepare(`UPDATE ${table} SET excluded=? WHERE id=?`).run(excluded ? 1 : 0, Number(id));
    if (!info.changes) throw new Error("The selected library item no longer exists.");
    return { ok: true };
  }

  removeLibraryFolder(folderId) {
    const id = Number(folderId);
    const transaction = this.db.transaction(() => {
      const info = this.db.prepare("UPDATE library_folders SET active=0 WHERE id=? AND active=1").run(id);
      if (!info.changes) throw new Error("That watched folder is no longer active.");
      this.db.prepare("UPDATE programs SET available=0 WHERE folder_id=?").run(id);
      this.db.prepare("UPDATE episodes SET available=0 WHERE program_id IN (SELECT id FROM programs WHERE folder_id=?)").run(id);
    });
    transaction();
    return { ok: true };
  }

  startFolderScan(folderId) {
    this.db.prepare("UPDATE programs SET available=0 WHERE folder_id=?").run(folderId);
    this.db.prepare("UPDATE episodes SET available=0 WHERE program_id IN (SELECT id FROM programs WHERE folder_id=?)").run(folderId);
  }

  findProgramByPath(folderId, folderPath) {
    return this.db.prepare("SELECT * FROM programs WHERE folder_id=? AND folder_path=? COLLATE NOCASE").get(folderId, folderPath);
  }

  findUnavailableProgramByFingerprint(folderId, fingerprints) {
    if (!fingerprints.length) return null;
    const placeholders = fingerprints.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT p.*, COUNT(*) AS matches
      FROM episodes e JOIN programs p ON p.id=e.program_id
      WHERE p.folder_id=? AND p.available=0 AND e.file_fingerprint IN (${placeholders})
      GROUP BY p.id ORDER BY matches DESC LIMIT 1
    `).get(folderId, ...fingerprints);
  }

  upsertProgram(folderId, folderPath, name, fingerprints = []) {
    let program = this.findProgramByPath(folderId, folderPath);
    if (!program) program = this.findUnavailableProgramByFingerprint(folderId, fingerprints);
    if (program) {
      this.db.prepare("UPDATE programs SET name=?, folder_path=?, available=1, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(name, folderPath, program.id);
      return this.db.prepare("SELECT * FROM programs WHERE id=?").get(program.id);
    }
    const info = this.db.prepare("INSERT INTO programs(folder_id,name,folder_path) VALUES (?,?,?)").run(folderId, name, folderPath);
    return this.db.prepare("SELECT * FROM programs WHERE id=?").get(info.lastInsertRowid);
  }

  upsertEpisode(programId, item) {
    let episode = this.db.prepare("SELECT * FROM episodes WHERE file_path=? COLLATE NOCASE").get(item.filePath);
    if (episode && episode.file_fingerprint && item.fingerprint && episode.file_fingerprint !== item.fingerprint) {
      const sameNumberedEpisode = episode.season_number !== null && episode.episode_number !== null &&
        item.seasonNumber !== null && item.episodeNumber !== null &&
        episode.season_number === item.seasonNumber && episode.episode_number === item.episodeNumber;
      const sameDatedEpisode = episode.air_date && item.airDate && episode.air_date === item.airDate;
      if (!sameNumberedEpisode && !sameDatedEpisode) {
        const archivedPath = `${episode.file_path} [replaced ${new Date().toISOString()} #${episode.id}]`;
        this.db.prepare("UPDATE episodes SET file_path=?, available=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(archivedPath, episode.id);
        episode = null;
      }
    }
    if (!episode && item.fingerprint) {
      episode = this.db.prepare("SELECT * FROM episodes WHERE file_fingerprint=? AND available=0 ORDER BY updated_at DESC LIMIT 1")
        .get(item.fingerprint);
    }
    if (episode) {
      this.db.prepare(`
        UPDATE episodes SET program_id=?, file_path=?, file_fingerprint=?, file_size=?,
          season_number=CASE WHEN manual_override=1 THEN season_number ELSE ? END,
          episode_number=CASE WHEN manual_override=1 THEN episode_number ELSE ? END,
          air_date=CASE WHEN manual_override=1 THEN air_date ELSE ? END,
          title=CASE WHEN manual_override=1 THEN title ELSE ? END,
          sort_key=CASE WHEN manual_override=1 THEN sort_key ELSE ? END,
          parse_confidence=CASE WHEN manual_override=1 THEN parse_confidence ELSE ? END,
          needs_review=CASE WHEN manual_override=1 THEN needs_review ELSE ? END, available=1,
          updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(programId, item.filePath, item.fingerprint, item.fileSize, item.seasonNumber, item.episodeNumber,
        item.airDate, item.title, item.sortKey, item.confidence, item.needsReview ? 1 : 0, episode.id);
      return episode.id;
    }
    const info = this.db.prepare(`
      INSERT INTO episodes(program_id,file_path,file_fingerprint,file_size,season_number,episode_number,air_date,title,sort_key,parse_confidence,needs_review)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(programId, item.filePath, item.fingerprint, item.fileSize, item.seasonNumber, item.episodeNumber,
      item.airDate, item.title, item.sortKey, item.confidence, item.needsReview ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  getEligibleEpisodes() {
    return this.db.prepare(`
      SELECT e.*, p.name AS program_name, p.last_selected_at, p.selection_count
      FROM programs p JOIN library_folders f ON f.id=p.folder_id JOIN episodes e ON e.id=(
        SELECT e2.id FROM episodes e2
        WHERE e2.program_id=p.id AND e2.completed=0 AND e2.excluded=0
        ORDER BY e2.sort_key, e2.id LIMIT 1
      )
      WHERE f.active=1 AND f.excluded=0 AND p.available=1 AND p.excluded=0
        AND e.available=1 AND e.excluded=0 AND e.needs_review=0
        AND NOT EXISTS (
          SELECT 1 FROM episodes unresolved
          WHERE unresolved.program_id=p.id AND unresolved.completed=0 AND unresolved.excluded=0 AND unresolved.needs_review=1
        )
      ORDER BY p.name COLLATE NOCASE
    `).all().map((row) => this.serializeEpisode(row));
  }

  getLastSelectedProgramId() {
    return this.db.prepare("SELECT program_id FROM selection_history ORDER BY id DESC LIMIT 1").get()?.program_id ?? null;
  }

  recordSelection(programId, episodeId) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("INSERT INTO selection_history(program_id,episode_id) VALUES (?,?)").run(programId, episodeId);
      this.db.prepare("UPDATE programs SET last_selected_at=CURRENT_TIMESTAMP, selection_count=selection_count+1 WHERE id=?").run(programId);
    });
    transaction();
  }

  getEpisode(id) {
    const row = this.db.prepare(`SELECT e.*, p.name AS program_name, p.last_selected_at, p.selection_count
      FROM episodes e JOIN programs p ON p.id=e.program_id WHERE e.id=?`).get(id);
    return row ? this.serializeEpisode(row) : null;
  }

  updateProgress(episodeId, positionSeconds, durationSeconds) {
    const position = Math.max(0, Number(positionSeconds) || 0);
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const settings = this.getSettings();
    const episode = this.db.prepare("SELECT * FROM episodes WHERE id=?").get(episodeId);
    if (!episode) return null;
    const shouldComplete = duration > 0 && position / duration >= Number(settings.completionThreshold);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE episodes SET position_seconds=?, duration_seconds=?, last_played_at=CURRENT_TIMESTAMP,
        completed=CASE WHEN ? THEN 1 ELSE completed END,
        completed_at=CASE WHEN ? AND completed=0 THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(position, duration, shouldComplete ? 1 : 0, shouldComplete ? 1 : 0, episodeId);
      if (shouldComplete && !episode.completed) {
        this.db.prepare("INSERT INTO watch_events(episode_id,event_type) VALUES (?,'completed')").run(episodeId);
      }
    });
    transaction();
    return this.getEpisode(episodeId);
  }

  markWatched(episodeId) {
    const existing = this.db.prepare("SELECT completed FROM episodes WHERE id=?").get(episodeId);
    if (!existing) return null;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE episodes SET completed=1, completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP),
        position_seconds=CASE WHEN duration_seconds>0 THEN duration_seconds ELSE position_seconds END,
        last_played_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(episodeId);
      if (!existing.completed) this.db.prepare("INSERT INTO watch_events(episode_id,event_type) VALUES (?,'completed')").run(episodeId);
    });
    transaction();
    return this.getEpisode(episodeId);
  }

  markUnwatched(episodeId) {
    this.db.prepare(`UPDATE episodes SET completed=0, completed_at=NULL, position_seconds=0,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(episodeId);
    this.db.prepare("INSERT INTO watch_events(episode_id,event_type) VALUES (?,'unwatched')").run(episodeId);
    return this.getEpisode(episodeId);
  }

  updateEpisodeMetadata(episodeId, changes) {
    const existing = this.db.prepare("SELECT * FROM episodes WHERE id=?").get(episodeId);
    if (!existing) throw new Error("Episode not found.");
    const seasonNumber = changes.seasonNumber === null || changes.seasonNumber === "" ? null : Number(changes.seasonNumber);
    const episodeNumber = changes.episodeNumber === null || changes.episodeNumber === "" ? null : Number(changes.episodeNumber);
    const airDate = String(changes.airDate || "").trim() || null;
    const title = String(changes.title || existing.title).trim() || existing.title;
    if ((seasonNumber === null) !== (episodeNumber === null)) throw new Error("Enter both a season and episode number.");
    if (seasonNumber !== null && (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber) || seasonNumber < 0 || episodeNumber < 0)) {
      throw new Error("Season and episode numbers must be whole numbers of zero or greater.");
    }
    let sortKey;
    if (seasonNumber !== null) sortKey = `1:${String(seasonNumber).padStart(4, "0")}:${String(episodeNumber).padStart(6, "0")}:${path.basename(existing.file_path).toLocaleLowerCase()}`;
    else if (/^(?:19|20)\d{2}-\d{2}-\d{2}$/.test(airDate || "")) sortKey = `2:${airDate}:${path.basename(existing.file_path).toLocaleLowerCase()}`;
    else throw new Error("Enter season and episode numbers, or a date in YYYY-MM-DD format.");
    this.db.prepare(`UPDATE episodes SET season_number=?, episode_number=?, air_date=?, title=?, sort_key=?,
      parse_confidence='manual', needs_review=0, manual_override=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(seasonNumber, episodeNumber, airDate, title, sortKey, episodeId);
    return this.getEpisode(episodeId);
  }

  undoLastCompletion() {
    const event = this.db.prepare("SELECT * FROM watch_events WHERE event_type='completed' AND undone=0 ORDER BY id DESC LIMIT 1").get();
    if (!event) return { ok: false, message: "There is no completion to undo." };
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE episodes SET completed=0, completed_at=NULL, position_seconds=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(event.episode_id);
      this.db.prepare("UPDATE watch_events SET undone=1 WHERE id=?").run(event.id);
    });
    transaction();
    return { ok: true };
  }

  getDashboard() {
    const folderCount = this.db.prepare("SELECT COUNT(*) AS count FROM library_folders WHERE active=1").get().count;
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM programs p JOIN library_folders f ON f.id=p.folder_id
        WHERE f.active=1 AND f.excluded=0 AND p.available=1 AND p.excluded=0) AS programs,
      (SELECT COUNT(*) FROM episodes e JOIN programs p ON p.id=e.program_id JOIN library_folders f ON f.id=p.folder_id
        WHERE f.active=1 AND f.excluded=0 AND p.available=1 AND p.excluded=0
          AND e.available=1 AND e.excluded=0 AND e.completed=0) AS unwatched_episodes`).get();
    const last = this.db.prepare(`SELECT e.*, p.name AS program_name
      FROM watch_events w JOIN episodes e ON e.id=w.episode_id JOIN programs p ON p.id=e.program_id
      WHERE w.event_type='completed' AND w.undone=0 AND e.completed=1 ORDER BY w.id DESC LIMIT 1`).get();
    const resume = this.db.prepare(`SELECT e.*, p.name AS program_name
      FROM episodes e JOIN programs p ON p.id=e.program_id JOIN library_folders f ON f.id=p.folder_id
      WHERE f.active=1 AND f.excluded=0 AND p.available=1 AND p.excluded=0
        AND e.available=1 AND e.excluded=0 AND e.completed=0 AND e.position_seconds>0
      ORDER BY e.last_played_at DESC LIMIT 1`).get();
    return {
      hasLibrary: folderCount > 0,
      counts: { programs: counts.programs, unwatchedEpisodes: counts.unwatched_episodes },
      lastWatched: last ? this.serializeEpisode(last) : null,
      resumeEpisode: resume ? this.serializeEpisode(resume) : null
    };
  }

  getLibrary() {
    const folders = this.getLibraryFolders();
    const eligibleProgramIds = new Set(this.getEligibleEpisodes().map((episode) => episode.programId));
    const programRows = this.db.prepare(`SELECT p.*,
      SUM(CASE WHEN e.available=1 AND e.completed=0 AND e.excluded=0 THEN 1 ELSE 0 END) AS unwatched_count,
      SUM(CASE WHEN e.needs_review=1 AND e.excluded=0 THEN 1 ELSE 0 END) AS needs_review_count
      FROM programs p JOIN library_folders f ON f.id=p.folder_id LEFT JOIN episodes e ON e.program_id=p.id
      WHERE f.active=1 GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all();
    const episodeQuery = this.db.prepare(`SELECT e.*, p.name AS program_name FROM episodes e JOIN programs p ON p.id=e.program_id
      WHERE e.program_id=? ORDER BY e.sort_key,e.id`);
    return {
      folders,
      programs: programRows.map((program) => ({
        id: program.id,
        folderId: program.folder_id,
        name: program.name,
        folderPath: program.folder_path,
        available: Boolean(program.available),
        excluded: Boolean(program.excluded),
        eligible: eligibleProgramIds.has(program.id),
        unwatchedCount: Number(program.unwatched_count || 0),
        needsReviewCount: Number(program.needs_review_count || 0),
        episodes: episodeQuery.all(program.id).map((row) => this.serializeEpisode(row))
      }))
    };
  }

  getHistory() {
    return this.db.prepare(`SELECT e.*, p.name AS program_name FROM episodes e JOIN programs p ON p.id=e.program_id
      WHERE e.last_played_at IS NOT NULL OR e.completed_at IS NOT NULL
      ORDER BY COALESCE(e.completed_at,e.last_played_at) DESC`).all().map((row) => ({
        ...this.serializeEpisode(row),
        watchedAt: row.completed_at || row.last_played_at,
        status: row.completed ? "completed" : "in-progress"
      }));
  }

  getProgramEpisodes(programId) {
    return this.db.prepare(`SELECT e.*, p.name AS program_name FROM episodes e JOIN programs p ON p.id=e.program_id
      WHERE e.program_id=? ORDER BY e.sort_key,e.id`).all(programId).map((row) => this.serializeEpisode(row));
  }

  createRenamePlans(plans) {
    const clear = this.db.prepare("DELETE FROM rename_plans WHERE status='preview' AND episode_id IN (SELECT id FROM episodes WHERE program_id=?)");
    const insert = this.db.prepare(`INSERT INTO rename_plans(episode_id,old_path,new_path,confidence,collision)
      VALUES (?,?,?,?,?)`);
    const transaction = this.db.transaction((items) => {
      if (items.length) clear.run(items[0].programId);
      return items.map((item) => {
        const info = insert.run(item.episodeId, item.oldPath, item.newPath, item.confidence, item.collision ? 1 : 0);
        return { id: Number(info.lastInsertRowid), ...item };
      });
    });
    return transaction(plans);
  }

  getRenamePlans(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM rename_plans WHERE id IN (${placeholders}) AND status='preview' ORDER BY id`).all(...ids);
  }

  finishRenamePlans(ids, operations) {
    const transaction = this.db.transaction(() => {
      for (const operation of operations) {
        if (operation.episodeId) this.db.prepare("UPDATE episodes SET file_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(operation.to, operation.episodeId);
      }
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        this.db.prepare(`UPDATE rename_plans SET status='applied' WHERE id IN (${placeholders})`).run(...ids);
      }
      this.db.prepare("INSERT INTO rename_operations(operations_json) VALUES (?)").run(JSON.stringify(operations));
    });
    transaction();
  }

  getLastRenameOperation() {
    const row = this.db.prepare("SELECT * FROM rename_operations WHERE undone=0 ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row, operations: JSON.parse(row.operations_json) } : null;
  }

  finishUndoRename(operationId, operations) {
    const transaction = this.db.transaction(() => {
      for (const operation of operations) {
        if (operation.episodeId) this.db.prepare("UPDATE episodes SET file_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(operation.from, operation.episodeId);
      }
      this.db.prepare("UPDATE rename_operations SET undone=1 WHERE id=?").run(operationId);
    });
    transaction();
  }

  serializeEpisode(row) {
    return {
      id: row.id,
      programId: row.program_id,
      programName: row.program_name,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      airDate: row.air_date,
      title: row.title,
      filePath: row.file_path,
      mediaUrl: `media://episode/${row.id}`,
      positionSeconds: Number(row.position_seconds || 0),
      durationSeconds: Number(row.duration_seconds || 0),
      completed: Boolean(row.completed),
      available: Boolean(row.available),
      needsReview: Boolean(row.needs_review),
      excluded: Boolean(row.excluded),
      lastSelectedAt: row.last_selected_at,
      selectionCount: Number(row.selection_count || 0)
    };
  }
}

module.exports = { MysteryDatabase, DEFAULT_SETTINGS };
