const { parseEpisode, isVideoFile } = require("../electron/episode-parser.cjs");

describe("episode filename parsing", () => {
  it.each([
    ["C:/Shows/Orbit/Orbit.S02E07.The.Return.mkv", 2, 7],
    ["C:/Shows/Orbit/Orbit 3x12.mp4", 3, 12],
    ["C:/Shows/Orbit/Orbit Season 4 Episode 9.avi", 4, 9],
    ["C:/Shows/Orbit/Season 05/003 - A Beginning.mkv", 5, 3]
  ])("orders %s", (filePath, season, episode) => {
    const parsed = parseEpisode(filePath);
    expect(parsed.seasonNumber).toBe(season);
    expect(parsed.episodeNumber).toBe(episode);
  });

  it("recognizes date-based episodes", () => {
    const parsed = parseEpisode("C:/Shows/Daily/Daily.Show.2026-09-29.mkv");
    expect(parsed.airDate).toBe("2026-09-29");
    expect(parsed.sortKey).toContain("2026-09-29");
  });

  it("naturally sorts ambiguous filenames and flags them for review", () => {
    const episode2 = parseEpisode("C:/Shows/Mixed/part 2.mkv");
    const episode10 = parseEpisode("C:/Shows/Mixed/part 10.mkv");
    expect(episode2.sortKey < episode10.sortKey).toBe(true);
    expect(episode2.needsReview).toBe(true);
  });

  it("ignores trailers and non-video files", () => {
    expect(isVideoFile("C:/Shows/Orbit/Orbit.S01E01.mkv")).toBe(true);
    expect(isVideoFile("C:/Shows/Orbit/sample.mkv")).toBe(false);
    expect(isVideoFile("C:/Shows/Orbit/Orbit.S01E01.srt")).toBe(false);
  });
});
