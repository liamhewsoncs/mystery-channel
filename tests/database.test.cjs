const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MysteryDatabase } = require("../electron/database.cjs");

describe("viewing progress and chronological eligibility", () => {
  let tempDirectory;
  let database;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mystery-channel-test-"));
    database = new MysteryDatabase(path.join(tempDirectory, "test.sqlite"));
    const folder = database.addLibraryFolder(path.join(tempDirectory, "Library"));
    const program = database.upsertProgram(folder.id, path.join(tempDirectory, "Library", "Orbit"), "Orbit");
    database.upsertEpisode(program.id, {
      filePath: path.join(tempDirectory, "Library", "Orbit", "Orbit S01E02.mkv"), fingerprint: "episode-2", fileSize: 20,
      seasonNumber: 1, episodeNumber: 2, airDate: null, title: "Second", sortKey: "1:0001:000002", confidence: "high", needsReview: false
    });
    database.upsertEpisode(program.id, {
      filePath: path.join(tempDirectory, "Library", "Orbit", "Orbit S01E01.mkv"), fingerprint: "episode-1", fileSize: 10,
      seasonNumber: 1, episodeNumber: 1, airDate: null, title: "First", sortKey: "1:0001:000001", confidence: "high", needsReview: false
    });
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("offers only the earliest unfinished episode", () => {
    let eligible = database.getEligibleEpisodes();
    expect(eligible).toHaveLength(1);
    expect(eligible[0].episodeNumber).toBe(1);
    database.markWatched(eligible[0].id);
    eligible = database.getEligibleEpisodes();
    expect(eligible[0].episodeNumber).toBe(2);
  });

  it("does not advance a partially watched episode", () => {
    const first = database.getEligibleEpisodes()[0];
    database.updateProgress(first.id, 50, 100);
    expect(database.getEligibleEpisodes()[0].id).toBe(first.id);
    expect(database.getEpisode(first.id).completed).toBe(false);
    database.updateProgress(first.id, 90, 100);
    expect(database.getEpisode(first.id).completed).toBe(true);
    expect(database.getEligibleEpisodes()[0].episodeNumber).toBe(2);
  });

  it("undoes the most recent completion", () => {
    const first = database.getEligibleEpisodes()[0];
    database.markWatched(first.id);
    expect(database.undoLastCompletion().ok).toBe(true);
    expect(database.getEpisode(first.id).completed).toBe(false);
    expect(database.getEligibleEpisodes()[0].id).toBe(first.id);
  });

  it("reports the most recently completed episode even within the same second", () => {
    const first = database.getEligibleEpisodes()[0];
    database.markWatched(first.id);
    const second = database.getEligibleEpisodes()[0];
    database.markWatched(second.id);
    expect(database.getDashboard().lastWatched.id).toBe(second.id);
  });

  it("blocks a programme when its earliest unfinished episode is unavailable", () => {
    const first = database.getEligibleEpisodes()[0];
    database.db.prepare("UPDATE episodes SET available=0 WHERE id=?").run(first.id);
    expect(database.getEligibleEpisodes()).toHaveLength(0);
  });

  it("blocks automatic playback until ambiguous ordering is reviewed", () => {
    const first = database.getEligibleEpisodes()[0];
    database.db.prepare(`INSERT INTO episodes(program_id,file_path,file_fingerprint,file_size,title,sort_key,needs_review)
      VALUES (?,?,?,?,?,?,1)`).run(first.programId, path.join(tempDirectory, "Library", "Orbit", "mystery.mkv"), "mystery", 4, "Mystery", "9:mystery");
    expect(database.getEligibleEpisodes()).toHaveLength(0);
  });

  it("lets the user explicitly exclude and restore an episode", () => {
    const first = database.getEligibleEpisodes()[0];
    database.setExcluded("episode", first.id, true);
    expect(database.getEligibleEpisodes()[0].episodeNumber).toBe(2);
    database.setExcluded("episode", first.id, false);
    expect(database.getEligibleEpisodes()[0].id).toBe(first.id);
  });

  it("excludes programmes and parent folders from random selection", () => {
    const first = database.getEligibleEpisodes()[0];
    database.setExcluded("program", first.programId, true);
    expect(database.getEligibleEpisodes()).toHaveLength(0);
    database.setExcluded("program", first.programId, false);
    const folder = database.getLibraryFolders()[0];
    database.setExcluded("folder", folder.id, true);
    expect(database.getEligibleEpisodes()).toHaveLength(0);
    expect(database.getDashboard().counts.programs).toBe(0);
    database.setExcluded("folder", folder.id, false);
    expect(database.getEligibleEpisodes()[0].id).toBe(first.id);
  });

  it("stops monitoring a removed folder without deleting history or progress", () => {
    const first = database.getEligibleEpisodes()[0];
    database.updateProgress(first.id, 25, 100);
    const folder = database.getLibraryFolders()[0];
    database.removeLibraryFolder(folder.id);
    expect(database.getLibraryFolders()).toHaveLength(0);
    expect(database.getLibrary().programs).toHaveLength(0);
    expect(database.getEpisode(first.id).positionSeconds).toBe(25);
    expect(database.getHistory()).toHaveLength(1);
    database.addLibraryFolder(folder.path);
    expect(database.getLibraryFolders()).toHaveLength(1);
    expect(database.getEpisode(first.id).positionSeconds).toBe(25);
  });

  it("does not transfer progress to different content replacing the same path", () => {
    const first = database.getEligibleEpisodes()[0];
    const replacementId = database.upsertEpisode(first.programId, {
      filePath: first.filePath, fingerprint: "different-content", fileSize: 99, seasonNumber: 9, episodeNumber: 1,
      airDate: null, title: "Replacement", sortKey: "1:0009:000001", confidence: "high", needsReview: false
    });
    expect(replacementId).not.toBe(first.id);
    expect(database.getEpisode(replacementId).positionSeconds).toBe(0);
    expect(database.getEpisode(replacementId).completed).toBe(false);
    expect(database.getEpisode(first.id).available).toBe(false);
  });

  it("retains progress when a fingerprint reappears at a new path", () => {
    const first = database.getEligibleEpisodes()[0];
    database.updateProgress(first.id, 42, 100);
    const folder = database.getLibraryFolders()[0];
    database.startFolderScan(folder.id);
    const program = database.upsertProgram(folder.id, path.join(tempDirectory, "Library", "Orbit Renamed"), "Orbit", ["episode-1"]);
    const movedId = database.upsertEpisode(program.id, {
      filePath: path.join(tempDirectory, "Library", "Orbit Renamed", "01.mkv"), fingerprint: "episode-1", fileSize: 10,
      seasonNumber: 1, episodeNumber: 1, airDate: null, title: "First", sortKey: "1:0001:000001", confidence: "high", needsReview: false
    });
    expect(movedId).toBe(first.id);
    expect(database.getEpisode(first.id).positionSeconds).toBe(42);
  });

  it("preserves a manual order correction across rescans", () => {
    const first = database.getEligibleEpisodes()[0];
    database.updateEpisodeMetadata(first.id, { seasonNumber: 7, episodeNumber: 4, title: "Corrected" });
    const folder = database.getLibraryFolders()[0];
    database.startFolderScan(folder.id);
    const program = database.upsertProgram(folder.id, path.join(tempDirectory, "Library", "Orbit"), "Orbit", ["episode-1"]);
    database.upsertEpisode(program.id, {
      filePath: first.filePath, fingerprint: "episode-1", fileSize: 10, seasonNumber: 1, episodeNumber: 1,
      airDate: null, title: "Wrong scan value", sortKey: "1:0001:000001", confidence: "high", needsReview: false
    });
    const corrected = database.getEpisode(first.id);
    expect(corrected.seasonNumber).toBe(7);
    expect(corrected.episodeNumber).toBe(4);
    expect(corrected.title).toBe("Corrected");
  });

  it("retains progress after closing and reopening the database", () => {
    const first = database.getEligibleEpisodes()[0];
    database.updateProgress(first.id, 37, 100);
    const databasePath = database.filePath;
    database.close();
    database = new MysteryDatabase(databasePath);
    expect(database.getEpisode(first.id).positionSeconds).toBe(37);
    expect(database.getEpisode(first.id).completed).toBe(false);
  });

  it("rejects a SQLite file that is not a Mystery Channel backup", () => {
    const invalidPath = path.join(tempDirectory, "unrelated.sqlite");
    const BetterSqlite = require("better-sqlite3");
    const unrelated = new BetterSqlite(invalidPath);
    unrelated.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY)");
    unrelated.close();
    expect(() => MysteryDatabase.validateBackup(invalidPath)).toThrow(/missing required data/i);
  });

  it("migrates an existing library to exclusion and soft-removal columns", () => {
    const databasePath = database.filePath;
    database.close();
    const BetterSqlite = require("better-sqlite3");
    const legacy = new BetterSqlite(databasePath);
    legacy.exec(`
      ALTER TABLE library_folders DROP COLUMN active;
      ALTER TABLE library_folders DROP COLUMN excluded;
      ALTER TABLE programs DROP COLUMN excluded;
      ALTER TABLE episodes DROP COLUMN excluded;
    `);
    legacy.close();
    database = new MysteryDatabase(databasePath);
    expect(database.db.pragma("table_info(library_folders)").map((column) => column.name)).toEqual(expect.arrayContaining(["active", "excluded"]));
    expect(database.db.pragma("table_info(programs)").map((column) => column.name)).toContain("excluded");
    expect(database.db.pragma("table_info(episodes)").map((column) => column.name)).toContain("excluded");
    expect(database.getEligibleEpisodes()).toHaveLength(1);
  });
});
