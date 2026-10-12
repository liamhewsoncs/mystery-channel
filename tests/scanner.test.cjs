const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MysteryDatabase } = require("../electron/database.cjs");
const { LibraryScanner } = require("../electron/scanner.cjs");

describe("library folder scanning", () => {
  let tempDirectory;
  let database;
  let scanner;

  afterEach(async () => {
    await scanner?.close();
    database?.close();
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("treats season directories inside an individually added show folder as one programme", async () => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mystery-channel-scan-"));
    const showFolder = path.join(tempDirectory, "Doctor Who");
    fs.mkdirSync(path.join(showFolder, "Season 01"), { recursive: true });
    fs.mkdirSync(path.join(showFolder, "Season 02"), { recursive: true });
    fs.writeFileSync(path.join(showFolder, "Season 01", "Doctor Who S01E01.mkv"), "season one");
    fs.writeFileSync(path.join(showFolder, "Season 02", "Doctor Who S02E01.mkv"), "season two");
    database = new MysteryDatabase(path.join(tempDirectory, "test.sqlite"));
    database.addLibraryFolder(showFolder);
    scanner = new LibraryScanner(database);
    await scanner.scanAll();
    const library = database.getLibrary();
    expect(library.programs).toHaveLength(1);
    expect(library.programs[0].name).toBe("Doctor Who");
    expect(library.programs[0].episodes.map((episode) => [episode.seasonNumber, episode.episodeNumber])).toEqual([[1, 1], [2, 1]]);
  });
});
