const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { MysteryDatabase } = require("./database.cjs");
const { LibraryScanner } = require("./scanner.cjs");
const { chooseFairProgram } = require("./selection.cjs");
const { previewRenames, applyRenames, undoLastRename } = require("./renamer.cjs");

protocol.registerSchemesAsPrivileged([{
  scheme: "media",
  privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true }
}]);

let mainWindow = null;
let database = null;
let scanner = null;
let databasePath = null;

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t"
};

function notifyLibraryChanged(payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("library:changed", payload);
}

function createDataServices() {
  database = new MysteryDatabase(databasePath);
  scanner = new LibraryScanner(database, notifyLibraryChanged);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#09090b",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    show: false,
    title: "Mystery Channel",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged ? url.startsWith("file:") : url.startsWith("http://127.0.0.1:5173");
    if (!allowed) event.preventDefault();
  });
  if (!app.isPackaged && process.argv.includes("--dev")) await mainWindow.loadURL("http://127.0.0.1:5173");
  else await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function registerMediaProtocol() {
  protocol.handle("media", async (request) => {
    try {
      const url = new URL(request.url);
      const episodeId = Number(url.pathname.split("/").filter(Boolean).pop());
      const episode = database?.getEpisode(episodeId);
      if (!episode?.available || !fs.existsSync(episode.filePath)) return new Response("Media unavailable", { status: 404 });
      const stat = await fsp.stat(episode.filePath);
      const size = stat.size;
      const range = request.headers.get("range");
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          start = match[1] ? Number(match[1]) : 0;
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
          }
          status = 206;
        }
      }
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": MIME_TYPES[path.extname(episode.filePath).toLocaleLowerCase()] || "application/octet-stream",
        "Content-Length": String(end - start + 1)
      };
      if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      if (request.method === "HEAD") return new Response(null, { status, headers });
      const stream = fs.createReadStream(episode.filePath, { start, end });
      return new Response(Readable.toWeb(stream), { status, headers });
    } catch (error) {
      return new Response(`Unable to open media: ${error.message}`, { status: 500 });
    }
  });
}

async function addFolder(folderPath) {
  if (!folderPath) return { added: false };
  const resolved = path.resolve(folderPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error("The selected location is not a folder.");
  database.addLibraryFolder(resolved);
  await scanner.restartWatcher();
  await scanner.scanAll();
  return { added: true, path: resolved };
}

function registerIpcHandlers() {
  ipcMain.handle("dashboard:get", () => database.getDashboard());
  ipcMain.handle("library:list", () => database.getLibrary());
  ipcMain.handle("history:list", () => database.getHistory());
  ipcMain.handle("settings:get", () => database.getSettings());
  ipcMain.handle("settings:save", (_event, partial) => database.saveSettings(partial));
  ipcMain.handle("library:pick-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder containing your programmes",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { added: false };
    return addFolder(result.filePaths[0]);
  });
  ipcMain.handle("library:add-folder", (_event, folderPath) => addFolder(folderPath));
  ipcMain.handle("library:set-excluded", (_event, input) => {
    if (!input || !["folder", "program", "episode"].includes(input.kind)) throw new Error("Invalid exclusion request.");
    const result = database.setExcluded(input.kind, input.id, Boolean(input.excluded));
    notifyLibraryChanged({ exclusion: true });
    return result;
  });
  ipcMain.handle("library:remove-folder", async (_event, folderId) => {
    const result = database.removeLibraryFolder(folderId);
    await scanner.restartWatcher();
    notifyLibraryChanged({ folderRemoved: true });
    return result;
  });
  ipcMain.handle("library:rescan", () => scanner.scanAll());
  ipcMain.handle("playback:choose-next", () => {
    const candidates = database.getEligibleEpisodes();
    const settings = database.getSettings();
    const chosen = chooseFairProgram(candidates, {
      avoidConsecutive: settings.avoidConsecutive,
      balance: settings.randomBalance,
      lastProgramId: database.getLastSelectedProgramId()
    });
    if (!chosen) return null;
    database.recordSelection(chosen.programId, chosen.id);
    return database.getEpisode(chosen.id);
  });
  ipcMain.handle("playback:update-progress", (_event, payload) => {
    if (!payload || !Number.isFinite(Number(payload.episodeId))) throw new Error("Invalid episode progress.");
    const result = database.updateProgress(payload.episodeId, payload.positionSeconds, payload.durationSeconds);
    notifyLibraryChanged({ progress: true });
    return result;
  });
  ipcMain.handle("playback:open-external", async (_event, episodeId) => {
    const episode = database.getEpisode(Number(episodeId));
    if (!episode?.available || !fs.existsSync(episode.filePath)) throw new Error("This episode file is unavailable.");
    const error = await shell.openPath(episode.filePath);
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle("playback:mark-watched", (_event, episodeId) => {
    const result = database.markWatched(Number(episodeId));
    notifyLibraryChanged({ progress: true });
    return result;
  });
  ipcMain.handle("playback:mark-unwatched", (_event, episodeId) => {
    const result = database.markUnwatched(Number(episodeId));
    notifyLibraryChanged({ progress: true });
    return result;
  });
  ipcMain.handle("library:update-episode", (_event, episodeId, changes) => {
    const result = database.updateEpisodeMetadata(Number(episodeId), changes || {});
    notifyLibraryChanged({ metadata: true });
    return result;
  });
  ipcMain.handle("playback:undo-completion", () => {
    const result = database.undoLastCompletion();
    if (result.ok) notifyLibraryChanged({ progress: true });
    return result;
  });
  ipcMain.handle("renames:preview", (_event, programId) => previewRenames(database, Number(programId)));
  ipcMain.handle("renames:apply", async (_event, planIds) => {
    const result = applyRenames(database, Array.isArray(planIds) ? planIds : []);
    if (result.applied) {
      await scanner.scanAll();
      notifyLibraryChanged({ renamed: true });
    }
    return result;
  });
  ipcMain.handle("renames:undo", async () => {
    const result = undoLastRename(database);
    if (result.ok) {
      await scanner.scanAll();
      notifyLibraryChanged({ renamed: true });
    }
    return result;
  });
  ipcMain.handle("database:backup", async () => {
    const defaultPath = path.join(app.getPath("documents"), `Mystery Channel Backup ${new Date().toISOString().slice(0, 10)}.sqlite`);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Back up Mystery Channel",
      defaultPath,
      filters: [{ name: "SQLite database", extensions: ["sqlite"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, message: "Backup cancelled." };
    database.checkpoint();
    await fsp.copyFile(databasePath, result.filePath);
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle("database:restore", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Restore a Mystery Channel backup",
      properties: ["openFile"],
      filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, message: "Restore cancelled." };
    const source = result.filePaths[0];
    const candidatePath = path.join(app.getPath("temp"), `mystery-channel-restore-${process.pid}-${Date.now()}.sqlite`);
    const safetyBackup = `${databasePath}.before-restore-${Date.now()}`;
    await fsp.copyFile(source, candidatePath);
    try {
      MysteryDatabase.validateBackup(candidatePath);
    } catch (error) {
      await fsp.unlink(candidatePath).catch(() => {});
      throw new Error(`That backup cannot be restored safely: ${error.message}`);
    }
    await scanner.close();
    database.checkpoint();
    try {
      await fsp.copyFile(databasePath, safetyBackup);
    } catch (error) {
      await scanner.restartWatcher();
      throw new Error(`A safety copy could not be created, so nothing was restored: ${error.message}`);
    }
    database.close();
    try {
      await fsp.copyFile(candidatePath, databasePath);
      for (const suffix of ["-wal", "-shm"]) {
        try { await fsp.unlink(`${databasePath}${suffix}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      createDataServices();
      await scanner.restartWatcher();
      await scanner.scanAll();
      notifyLibraryChanged({ restored: true });
      return { ok: true, safetyBackup };
    } catch (error) {
      await scanner?.close().catch(() => {});
      try { database?.close(); } catch { /* A failed candidate may not have opened fully. */ }
      await fsp.copyFile(safetyBackup, databasePath);
      for (const suffix of ["-wal", "-shm"]) await fsp.unlink(`${databasePath}${suffix}`).catch(() => {});
      createDataServices();
      await scanner.restartWatcher();
      await scanner.scanAll();
      throw new Error(`Restore failed, so the original database was put back: ${error.message}`);
    } finally {
      await fsp.unlink(candidatePath).catch(() => {});
    }
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.mysterychannel.desktop");
  Menu.setApplicationMenu(null);
  databasePath = path.join(process.env.MYSTERY_CHANNEL_DATA_DIR || app.getPath("userData"), "mystery-channel.sqlite");
  createDataServices();
  registerMediaProtocol();
  registerIpcHandlers();
  await createWindow();
  await scanner.restartWatcher();
  scanner.scanAll().catch((error) => console.error("Initial library scan failed", error));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  scanner?.close().catch(() => {});
  database?.close();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
