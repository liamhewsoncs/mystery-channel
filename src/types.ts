export interface Episode {
  id: number | string;
  programId: number | string;
  programName: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  airDate: string | null;
  title: string;
  filePath: string;
  mediaUrl: string;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  available: boolean;
  needsReview: boolean;
  excluded: boolean;
}

export interface Program {
  id: number | string;
  folderId: number | string;
  name: string;
  episodes: Episode[];
  artworkUrl?: string | null;
  folderPath?: string;
  available: boolean;
  eligible: boolean;
  unwatchedCount: number;
  needsReviewCount: number;
  excluded: boolean;
}

export interface LibraryFolder {
  id: number | string;
  path: string;
  excluded: boolean;
}

export interface Library {
  folders: LibraryFolder[];
  programs: Program[];
}

export interface Dashboard {
  hasLibrary: boolean;
  counts: { programs: number; unwatchedEpisodes: number };
  lastWatched: Episode | null;
  resumeEpisode: Episode | null;
}

export interface HistoryItem extends Episode {
  watchedAt: string | null;
  status: 'completed' | 'in-progress';
}

export interface Settings {
  completionThreshold?: number;
  autoplay?: boolean;
  avoidConsecutive?: boolean;
  randomBalance?: number;
  organizerPattern?: string;
  [key: string]: unknown;
}

export interface RenamePlan {
  id: number | string;
  episodeId: number | string;
  oldPath: string;
  newPath: string;
  confidence: string;
  collision: boolean;
}

export interface MysteryChannelApi {
  getDashboard(): Promise<Dashboard>;
  pickLibraryFolder(): Promise<{ added: boolean; path?: string }>;
  addLibraryFolder(path?: string): Promise<unknown>;
  rescan(): Promise<unknown>;
  listLibrary(): Promise<Library>;
  setExcluded(request: { kind: 'folder' | 'program' | 'episode'; id: number | string; excluded: boolean }): Promise<{ ok: boolean }>;
  removeLibraryFolder(folderId: number | string): Promise<{ ok: boolean }>;
  chooseNext(): Promise<Episode | null>;
  updateProgress(progress: { episodeId: number | string; positionSeconds: number; durationSeconds: number }): Promise<unknown>;
  openExternalPlayer(episodeId: number | string): Promise<{ ok: boolean }>;
  updateEpisodeMetadata(episodeId: number | string, metadata: { seasonNumber: number | null; episodeNumber: number | null; airDate?: string | null; title?: string }): Promise<Episode>;
  markWatched(episodeId: number | string): Promise<unknown>;
  markUnwatched(episodeId: number | string): Promise<unknown>;
  undoLastCompletion(): Promise<unknown>;
  listHistory(): Promise<HistoryItem[]>;
  getSettings(): Promise<Settings>;
  saveSettings(partial: Partial<Settings>): Promise<unknown>;
  previewRenames(programId: number | string): Promise<{ plans: RenamePlan[]; warnings: string[] }>;
  applyRenames(planIds: (number | string)[]): Promise<{ applied: number; errors: string[] }>;
  undoLastRename(): Promise<unknown>;
  backupDatabase(): Promise<unknown>;
  restoreDatabase(): Promise<unknown>;
  onLibraryChanged(callback: () => void): () => void;
}

declare global {
  interface Window {
    mysteryChannel?: MysteryChannelApi;
  }
}
