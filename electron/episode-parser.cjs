const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".mpg", ".mpeg", ".ts", ".m2ts"
]);

const IGNORED_NAME_PARTS = /\b(?:sample|trailer|featurette|behind[ ._-]the[ ._-]scenes)\b/i;

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
    !IGNORED_NAME_PARTS.test(path.basename(filePath, path.extname(filePath)));
}

function cleanTitle(value) {
  return value
    .replace(/[._]+/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*(?:1080|720|2160|web|bluray|x26|hevc)[^)]*\)/gi, " ")
    .replace(/\b(?:2160p|1080p|720p|480p|web[- .]?dl|webrip|blu[- .]?ray|brrip|hdtv|x26[45]|hevc|aac\d?(?:\.\d)?|ddp?\d?(?:\.\d)?)\b.*$/i, " ")
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEpisode(filePath) {
  const extension = path.extname(filePath);
  const raw = path.basename(filePath, extension);
  const parent = path.basename(path.dirname(filePath));
  let seasonNumber = null;
  let episodeNumber = null;
  let airDate = null;
  let confidence = "low";
  let match = raw.match(/\bS(?:eason)?[ ._-]?(\d{1,3})[ ._-]*E(?:p(?:isode)?)?[ ._-]?(\d{1,4})(?:[ ._-]*(?:-|to)?[ ._-]*E?(\d{1,4}))?\b/i);

  if (match) {
    seasonNumber = Number(match[1]);
    episodeNumber = Number(match[2]);
    confidence = "high";
  } else {
    match = raw.match(/\b(\d{1,3})x(\d{1,4})(?:[- ](?:\d{1,3}x)?(\d{1,4}))?\b/i);
    if (match) {
      seasonNumber = Number(match[1]);
      episodeNumber = Number(match[2]);
      confidence = "high";
    } else {
      match = raw.match(/\bSeason[ ._-]?(\d{1,3})[ ._-]+(?:Episode|Ep)[ ._-]?(\d{1,4})\b/i);
      if (match) {
        seasonNumber = Number(match[1]);
        episodeNumber = Number(match[2]);
        confidence = "high";
      }
    }
  }

  if (seasonNumber === null) {
    const dateMatch = raw.match(/\b((?:19|20)\d{2})[. _-](0?[1-9]|1[0-2])[. _-](0?[1-9]|[12]\d|3[01])\b/);
    if (dateMatch) {
      airDate = `${dateMatch[1]}-${String(Number(dateMatch[2])).padStart(2, "0")}-${String(Number(dateMatch[3])).padStart(2, "0")}`;
      confidence = "high";
    }
  }

  if (seasonNumber === null && !airDate) {
    const seasonFolder = parent.match(/^(?:season|series)[ ._-]?(\d{1,3})$/i);
    const leadingEpisode = raw.match(/^(?:episode|ep)?[ ._-]?(\d{1,4})(?:\D|$)/i);
    if (seasonFolder && leadingEpisode) {
      seasonNumber = Number(seasonFolder[1]);
      episodeNumber = Number(leadingEpisode[1]);
      confidence = "medium";
    } else {
      const simpleEpisode = raw.match(/^(\d{1,4})[ ._-]+/);
      if (simpleEpisode) {
        seasonNumber = seasonFolder ? Number(seasonFolder[1]) : 1;
        episodeNumber = Number(simpleEpisode[1]);
        confidence = seasonFolder ? "medium" : "low";
      }
    }
  }

  let title = raw;
  title = title
    .replace(/\bS(?:eason)?[ ._-]?\d{1,3}[ ._-]*E(?:p(?:isode)?)?[ ._-]?\d{1,4}(?:[ ._-]*(?:-|to)?[ ._-]*E?\d{1,4})?\b/i, " ")
    .replace(/\b\d{1,3}x\d{1,4}(?:[- ](?:\d{1,3}x)?\d{1,4})?\b/i, " ")
    .replace(/\bSeason[ ._-]?\d{1,3}[ ._-]+(?:Episode|Ep)[ ._-]?\d{1,4}\b/i, " ")
    .replace(/\b(?:19|20)\d{2}[. _-](?:0?[1-9]|1[0-2])[. _-](?:0?[1-9]|[12]\d|3[01])\b/, " ")
    .replace(/^(?:episode|ep)?[ ._-]?\d{1,4}[ ._-]*/i, " ");
  title = cleanTitle(title) || `Episode ${episodeNumber ?? airDate ?? "Unknown"}`;

  let sortKey;
  if (seasonNumber !== null && episodeNumber !== null) {
    sortKey = `1:${String(seasonNumber).padStart(4, "0")}:${String(episodeNumber).padStart(6, "0")}:${raw.toLocaleLowerCase()}`;
  } else if (airDate) {
    sortKey = `2:${airDate}:${raw.toLocaleLowerCase()}`;
  } else {
    sortKey = `9:${raw.toLocaleLowerCase().replace(/\d+/g, (n) => n.padStart(12, "0"))}`;
  }

  return {
    seasonNumber,
    episodeNumber,
    airDate,
    title,
    sortKey,
    confidence,
    needsReview: confidence === "low"
  };
}

module.exports = { VIDEO_EXTENSIONS, isVideoFile, parseEpisode, cleanTitle };
