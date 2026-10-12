const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MysteryDatabase } = require("../electron/database.cjs");
const { previewRenames, applyRenames, undoLastRename } = require("../electron/renamer.cjs");

describe("safe file organizer", () => {
  let tempDirectory;
  let database;
  let program;
  let originalPath;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mystery-channel-rename-"));
    const libraryPath = path.join(tempDirectory, "Library");
    const programPath = path.join(libraryPath, "Orbit");
    fs.mkdirSync(programPath, { recursive: true });
    originalPath = path.join(programPath, "orbit.1x1.pilot.mkv");
    fs.writeFileSync(originalPath, "synthetic video data");
    fs.writeFileSync(path.join(programPath, "orbit.1x1.pilot.en.srt"), "subtitle");
    database = new MysteryDatabase(path.join(tempDirectory, "test.sqlite"));
    const folder = database.addLibraryFolder(libraryPath);
    program = database.upsertProgram(folder.id, programPath, "Orbit");
    database.upsertEpisode(program.id, {
      filePath: originalPath, fingerprint: "orbit-1", fileSize: 20, seasonNumber: 1, episodeNumber: 1,
      airDate: null, title: "Pilot", sortKey: "1:0001:000001", confidence: "high", needsReview: false
    });
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("previews, applies, and reverses video and subtitle renames", () => {
    const preview = previewRenames(database, program.id);
    expect(preview.plans).toHaveLength(1);
    expect(fs.existsSync(preview.plans[0].newPath)).toBe(false);
    const result = applyRenames(database, [preview.plans[0].id]);
    expect(result.applied).toBe(1);
    expect(fs.existsSync(preview.plans[0].newPath)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(originalPath), "Orbit - S01E01 - Pilot.en.srt"))).toBe(true);
    expect(undoLastRename(database).ok).toBe(true);
    expect(fs.existsSync(originalPath)).toBe(true);
  });

  it("journals a rename that cannot be rolled back", () => {
    const preview = previewRenames(database, program.id);
    const originalRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls === 1) return originalRename(from, to);
      throw new Error(calls === 2 ? "simulated forward failure" : "simulated rollback failure");
    };
    let result;
    try {
      result = applyRenames(database, [preview.plans[0].id]);
    } finally {
      fs.renameSync = originalRename;
    }
    expect(result.applied).toBe(1);
    expect(result.errors.join(" ")).toMatch(/recorded for Undo/i);
    expect(database.getEpisode(preview.plans[0].episodeId).filePath).toBe(preview.plans[0].newPath);
    expect(database.getLastRenameOperation()).not.toBeNull();
  });
});
