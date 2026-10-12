const fs = require("node:fs");
const path = require("node:path");

const SIDECAR_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".nfo"]);

function sanitizeSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || "Untitled";
}

function stripProgramPrefix(title, programName) {
  const titleWords = title.replace(/[._-]+/g, " ").trim();
  const programWords = programName.replace(/[._-]+/g, " ").trim();
  if (titleWords.toLocaleLowerCase().startsWith(programWords.toLocaleLowerCase())) {
    return titleWords.slice(programWords.length).replace(/^[\s._-]+/, "") || titleWords;
  }
  return titleWords;
}

function formatEpisodeFilename(episode) {
  const extension = path.extname(episode.filePath);
  const season = String(episode.seasonNumber).padStart(2, "0");
  const number = String(episode.episodeNumber).padStart(2, "0");
  const title = sanitizeSegment(stripProgramPrefix(episode.title, episode.programName));
  return `${sanitizeSegment(episode.programName)} - S${season}E${number} - ${title}${extension.toLocaleLowerCase()}`;
}

function previewRenames(database, programId) {
  const episodes = database.getProgramEpisodes(programId);
  const rawPlans = [];
  const warnings = [];
  for (const episode of episodes) {
    if (!episode.available) continue;
    if (episode.seasonNumber === null || episode.episodeNumber === null) {
      warnings.push(`${path.basename(episode.filePath)} needs a confirmed season and episode number before it can be renamed.`);
      continue;
    }
    const newPath = path.join(path.dirname(episode.filePath), formatEpisodeFilename(episode));
    if (newPath.toLocaleLowerCase() === episode.filePath.toLocaleLowerCase()) continue;
    rawPlans.push({
      programId,
      episodeId: episode.id,
      oldPath: episode.filePath,
      newPath,
      confidence: episode.needsReview ? "low" : "high",
      collision: fs.existsSync(newPath)
    });
  }
  const counts = new Map();
  for (const plan of rawPlans) {
    const target = plan.newPath.toLocaleLowerCase();
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  for (const plan of rawPlans) {
    if ((counts.get(plan.newPath.toLocaleLowerCase()) || 0) > 1) plan.collision = true;
  }
  const plans = database.createRenamePlans(rawPlans).map((plan) => ({
    id: plan.id,
    episodeId: plan.episodeId,
    oldPath: plan.oldPath,
    newPath: plan.newPath,
    confidence: plan.confidence,
    collision: Boolean(plan.collision)
  }));
  if (!plans.length && !warnings.length) warnings.push("These files already follow the organizer naming pattern.");
  return { plans, warnings };
}

function findSidecars(filePath, targetPath) {
  const directory = path.dirname(filePath);
  const sourceStem = path.basename(filePath, path.extname(filePath));
  const targetStem = path.basename(targetPath, path.extname(targetPath));
  let names = [];
  try { names = fs.readdirSync(directory); } catch { return []; }
  return names.flatMap((name) => {
    if (!name.startsWith(`${sourceStem}.`)) return [];
    const finalExtension = path.extname(name).toLocaleLowerCase();
    if (!SIDECAR_EXTENSIONS.has(finalExtension)) return [];
    const suffix = name.slice(sourceStem.length);
    return [{ from: path.join(directory, name), to: path.join(directory, `${targetStem}${suffix}`), episodeId: null }];
  });
}

function applyRenames(database, planIds) {
  const uniqueIds = [...new Set((planIds || []).map(Number).filter(Number.isFinite))];
  const plans = database.getRenamePlans(uniqueIds);
  const errors = [];
  const operations = [];
  for (const plan of plans) {
    if (plan.collision) {
      errors.push(`Skipped ${path.basename(plan.old_path)} because its destination conflicts with another file.`);
      continue;
    }
    if (!fs.existsSync(plan.old_path)) {
      errors.push(`Skipped ${path.basename(plan.old_path)} because the source file is unavailable.`);
      continue;
    }
    if (fs.existsSync(plan.new_path) && plan.old_path.toLocaleLowerCase() !== plan.new_path.toLocaleLowerCase()) {
      errors.push(`Skipped ${path.basename(plan.old_path)} because ${path.basename(plan.new_path)} already exists.`);
      continue;
    }
    operations.push({ from: plan.old_path, to: plan.new_path, episodeId: plan.episode_id, planId: plan.id });
    operations.push(...findSidecars(plan.old_path, plan.new_path));
  }

  const completed = [];
  try {
    for (const operation of operations) {
      if (operation.from === operation.to) continue;
      if (fs.existsSync(operation.to)) throw new Error(`${path.basename(operation.to)} already exists.`);
      fs.renameSync(operation.from, operation.to);
      completed.push(operation);
    }
    if (completed.length) database.finishRenamePlans(plans.map((plan) => plan.id), completed);
    return { applied: completed.filter((item) => item.episodeId).length, errors };
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of completed.reverse()) {
      try {
        if (fs.existsSync(operation.to) && !fs.existsSync(operation.from)) fs.renameSync(operation.to, operation.from);
      } catch (rollbackError) {
        rollbackErrors.push(`${path.basename(operation.to)}: ${rollbackError.message}`);
      }
    }
    const unresolved = completed.filter((operation) => fs.existsSync(operation.to));
    if (unresolved.length) {
      const unresolvedPlanIds = unresolved.map((operation) => operation.planId).filter(Boolean);
      database.finishRenamePlans(unresolvedPlanIds, unresolved);
      return {
        applied: unresolved.filter((item) => item.episodeId).length,
        errors: [...errors, `Renaming stopped: ${error.message}`, `${unresolved.length} change(s) could not be rolled back and were recorded for Undo. ${rollbackErrors.join(" ")}`]
      };
    }
    return { applied: 0, errors: [...errors, `No changes were kept: ${error.message}`] };
  }
}

function undoLastRename(database) {
  const record = database.getLastRenameOperation();
  if (!record) return { ok: false, message: "There is no rename operation to undo." };
  const reversed = [...record.operations].reverse();
  const completed = [];
  try {
    for (const operation of reversed) {
      if (!fs.existsSync(operation.to)) throw new Error(`${path.basename(operation.to)} is no longer available.`);
      if (fs.existsSync(operation.from)) throw new Error(`${path.basename(operation.from)} already exists.`);
      fs.renameSync(operation.to, operation.from);
      completed.push(operation);
    }
    database.finishUndoRename(record.id, record.operations);
    return { ok: true };
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of completed.reverse()) {
      try {
        if (fs.existsSync(operation.from) && !fs.existsSync(operation.to)) fs.renameSync(operation.from, operation.to);
      } catch (rollbackError) {
        rollbackErrors.push(`${path.basename(operation.from)}: ${rollbackError.message}`);
      }
    }
    const recovery = rollbackErrors.length ? ` Some paths need manual recovery: ${rollbackErrors.join(" ")}` : " No database changes were made.";
    return { ok: false, message: `The rename could not be undone safely: ${error.message}.${recovery}` };
  }
}

module.exports = { sanitizeSegment, formatEpisodeFilename, previewRenames, applyRenames, undoLastRename };
