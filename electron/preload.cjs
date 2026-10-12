const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mysteryChannel", {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  pickLibraryFolder: () => ipcRenderer.invoke("library:pick-folder"),
  addLibraryFolder: (folderPath) => ipcRenderer.invoke("library:add-folder", folderPath),
  setExcluded: (input) => ipcRenderer.invoke("library:set-excluded", input),
  removeLibraryFolder: (folderId) => ipcRenderer.invoke("library:remove-folder", folderId),
  rescan: () => ipcRenderer.invoke("library:rescan"),
  listLibrary: () => ipcRenderer.invoke("library:list"),
  chooseNext: () => ipcRenderer.invoke("playback:choose-next"),
  updateProgress: (progress) => ipcRenderer.invoke("playback:update-progress", progress),
  openExternalPlayer: (episodeId) => ipcRenderer.invoke("playback:open-external", episodeId),
  markWatched: (episodeId) => ipcRenderer.invoke("playback:mark-watched", episodeId),
  markUnwatched: (episodeId) => ipcRenderer.invoke("playback:mark-unwatched", episodeId),
  updateEpisodeMetadata: (episodeId, changes) => ipcRenderer.invoke("library:update-episode", episodeId, changes),
  undoLastCompletion: () => ipcRenderer.invoke("playback:undo-completion"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),
  previewRenames: (programId) => ipcRenderer.invoke("renames:preview", programId),
  applyRenames: (planIds) => ipcRenderer.invoke("renames:apply", planIds),
  undoLastRename: () => ipcRenderer.invoke("renames:undo"),
  backupDatabase: () => ipcRenderer.invoke("database:backup"),
  restoreDatabase: () => ipcRenderer.invoke("database:restore"),
  onLibraryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  }
});
