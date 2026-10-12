import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Dashboard, Episode, HistoryItem, Library, LibraryFolder, Program, RenamePlan, Settings } from './types';

type Page = 'watch' | 'library' | 'history';
const emptyDashboard: Dashboard = { hasLibrary: false, counts: { programs: 0, unwatchedEpisodes: 0 }, lastWatched: null, resumeEpisode: null };
const emptyLibrary: Library = { folders: [], programs: [] };
const defaultSettings: Settings = { completionThreshold: 0.9, autoplay: true, avoidConsecutive: true, randomBalance: 0.7, organizerPattern: '{programme} - S{season}E{episode} - {title}' };

function Icon({ name, size = 20 }: { name: 'play' | 'library' | 'history' | 'settings' | 'plus' | 'refresh' | 'chevron' | 'search' | 'close' | 'shuffle' | 'arrow' | 'folder' | 'check' | 'warning' | 'back'; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    play: <path d="m8 5 11 7-11 7V5Z" />,
    library: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16M13 8h5M13 12h5" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l-1.8 1.8a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6h-2.6a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-1.8-1.8A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.6-1H5v-2.6a1.7 1.7 0 0 0 1.6-1A1.7 1.7 0 0 0 6.3 8l1.8-1.8A1.7 1.7 0 0 0 10 6.5a1.7 1.7 0 0 0 1-1.6h2.6a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3L18.3 8a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v2.6h-1.4A1.7 1.7 0 0 0 19.4 15Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.5-2" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    shuffle: <><path d="M4 7h3c5 0 5 10 10 10h3M17 14l3 3-3 3M4 17h3c2 0 3-2 4-4M14 9c1-1 2-2 3-2h3M17 4l3 3-3 3" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    folder: <path d="M3 6h7l2 2h9v11H3V6Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    warning: <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
    back: <path d="m15 18-6-6 6-6" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function episodeCode(episode: Episode) {
  if (episode.seasonNumber != null && episode.episodeNumber != null) return `S${String(episode.seasonNumber).padStart(2, '0')} · E${String(episode.episodeNumber).padStart(2, '0')}`;
  if (episode.airDate) return episode.airDate;
  return 'Episode';
}

function episodeName(episode: Episode) { return `${episode.programName} · ${episodeCode(episode)}${episode.title ? ` · ${episode.title}` : ''}`; }
function time(seconds: number) { if (!Number.isFinite(seconds) || seconds < 1) return '0:00'; const s = Math.floor(seconds); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function date(value: string | null) { if (!value) return 'Recently'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function displayError(error: unknown) { return error instanceof Error ? error.message : String(error); }

export default function App() {
  const api = window.mysteryChannel;
  const [page, setPage] = useState<Page>('watch');
  const [dashboard, setDashboard] = useState<Dashboard>(emptyDashboard);
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [activeEpisode, setActiveEpisode] = useState<Episode | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualFolderOpen, setManualFolderOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [folderToRemove, setFolderToRemove] = useState<LibraryFolder | null>(null);
  const [renameProgram, setRenameProgram] = useState<Program | null>(null);
  const [editingEpisode, setEditingEpisode] = useState<Episode | null>(null);
  const [episodeForm, setEpisodeForm] = useState({ season: '', episode: '', airDate: '', title: '' });
  const [renamePlans, setRenamePlans] = useState<RenamePlan[]>([]);
  const [renameWarnings, setRenameWarnings] = useState<string[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<(string | number)[]>([]);
  const [expandedProgram, setExpandedProgram] = useState<string | number | null>(null);
  const [search, setSearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastProgressRef = useRef(0);
  const resumeSeekRef = useRef(false);

  const reload = useCallback(async () => {
    if (!api) return;
    const [nextDashboard, nextLibrary, nextHistory, nextSettings] = await Promise.all([api.getDashboard(), api.listLibrary(), api.listHistory(), api.getSettings()]);
    setDashboard(nextDashboard);
    setLibrary(nextLibrary);
    setHistory(nextHistory);
    setSettings(nextSettings);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void reload().catch(error => setNotice(`Could not load your library: ${displayError(error)}`));
    return api.onLibraryChanged(() => { void reload().catch(error => setNotice(displayError(error))); });
  }, [api, reload]);

  async function run<T>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(key); setNotice(null);
    try { const result = await action(); if (success) setNotice(success); return result; }
    catch (error) { setNotice(displayError(error)); return undefined; }
    finally { setBusy(null); }
  }

  function openEpisode(episode: Episode) {
    if (!episode.available) { setNotice('This file is unavailable. Reconnect its drive or locate it in Library.'); return; }
    setActiveEpisode(episode); setPlayerOpen(true); setPage('watch'); resumeSeekRef.current = false; lastProgressRef.current = 0;
  }

  async function chooseNext() {
    if (!api) return;
    const episode = await run('choose', () => api.chooseNext());
    if (episode) openEpisode(episode);
    else if (episode === null) setNotice('You’re all caught up. Add another programme to keep the channel going.');
  }

  async function addFolder() {
    if (!api) return;
    const result = await run('folder', () => api.pickLibraryFolder());
    if (result?.added) { await reload(); setPage('library'); setNotice('Library folder added. Your programmes are ready to scan.'); }
  }

  async function addManualFolder() {
    if (!api || !manualPath.trim()) return;
    const result = await run('manual-folder', () => api.addLibraryFolder(manualPath.trim()));
    if (result !== undefined) { setManualFolderOpen(false); setManualPath(''); await reload(); setNotice('Library folder added.'); }
  }

  async function scan() { if (!api) return; await run('scan', async () => { await api.rescan(); await reload(); }, 'Library scan complete.'); }

  async function setExcluded(kind: 'folder' | 'program' | 'episode', id: number | string, excluded: boolean) {
    if (!api) return;
    const result = await run('exclude', async () => {
      const response = await api.setExcluded({ kind, id, excluded });
      if (!response.ok) throw new Error('Could not update the watch list.');
      await reload();
      return true;
    });
    if (result) setNotice(excluded ? 'Excluded from random picks. Watch history is kept.' : 'Included in random picks again.');
  }

  async function removeFolder() {
    if (!api || !folderToRemove) return;
    const result = await run('remove-folder', async () => {
      const response = await api.removeLibraryFolder(folderToRemove.id);
      if (!response.ok) throw new Error('Could not remove the library folder.');
      await reload();
      return true;
    });
    if (result) { setFolderToRemove(null); setNotice('Folder removed from monitoring. Media files and watch history were kept.'); }
  }

  async function saveProgress(force = false) {
    const video = videoRef.current;
    if (!api || !activeEpisode || !video) return;
    const now = Date.now();
    if (!force && now - lastProgressRef.current < 5000) return;
    lastProgressRef.current = now;
    const positionSeconds = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const durationSeconds = Number.isFinite(video.duration) ? video.duration : activeEpisode.durationSeconds;
    try { await api.updateProgress({ episodeId: activeEpisode.id, positionSeconds, durationSeconds }); }
    catch (error) { setNotice(`Progress could not be saved: ${displayError(error)}`); }
  }

  async function finishEpisode() {
    if (!api || !activeEpisode) return;
    const completed = activeEpisode;
    const result = await run('complete', async () => { await api.markWatched(completed.id); await reload(); return true; });
    if (!result) return;
    setPlayerOpen(false); setActiveEpisode(null);
    if (settings.autoplay) void chooseNext();
  }

  async function closePlayer(chooseAnother = false) {
    await saveProgress(true);
    setPlayerOpen(false);
    setActiveEpisode(null);
    await reload();
    if (chooseAnother) await chooseNext();
  }

  async function markEpisode(episode: Episode, watched: boolean) {
    if (!api) return;
    await run('mark', async () => { if (watched) await api.markWatched(episode.id); else await api.markUnwatched(episode.id); await reload(); }, watched ? 'Episode marked watched.' : 'Episode marked unwatched.');
  }

  function editEpisode(episode: Episode) {
    setEditingEpisode(episode);
    setEpisodeForm({ season: episode.seasonNumber == null ? '' : String(episode.seasonNumber), episode: episode.episodeNumber == null ? '' : String(episode.episodeNumber), airDate: episode.airDate ?? '', title: episode.title });
  }

  async function saveEpisode() {
    if (!api || !editingEpisode) return;
    const seasonNumber = episodeForm.season === '' ? null : Number(episodeForm.season);
    const episodeNumber = episodeForm.episode === '' ? null : Number(episodeForm.episode);
    if ((seasonNumber === null) !== (episodeNumber === null)) { setNotice('Enter both season and episode numbers, or leave both blank and use an air date.'); return; }
    if (seasonNumber === null && !episodeForm.airDate) { setNotice('Enter season and episode numbers or an air date to set the order.'); return; }
    const result = await run('edit-episode', async () => { await api.updateEpisodeMetadata(editingEpisode.id, { seasonNumber, episodeNumber, airDate: episodeForm.airDate || null, title: episodeForm.title.trim() }); await reload(); return true; });
    if (result) { setEditingEpisode(null); setNotice('Episode order saved.'); }
  }

  async function openRenamer(program: Program) {
    if (!api) return;
    const result = await run('preview', () => api.previewRenames(program.id));
    if (!result) return;
    setRenameProgram(program); setRenamePlans(result.plans); setRenameWarnings(result.warnings);
    setSelectedPlans(result.plans.filter(plan => !plan.collision && plan.confidence.toLowerCase() === 'high').map(plan => plan.id));
  }

  async function applyRenames() {
    if (!api || selectedPlans.length === 0) return;
    const result = await run('rename', () => api.applyRenames(selectedPlans));
    if (!result) return;
    setRenameProgram(null); setRenamePlans([]); setSelectedPlans([]);
    await reload();
    setNotice(result.errors.length ? `${result.applied} files renamed. ${result.errors.join(' ')}` : `${result.applied} files renamed. You can undo the last rename in Settings.`);
  }

  async function saveSetting(partial: Partial<Settings>) {
    if (!api) return;
    const previous = settings; setSettings({ ...settings, ...partial });
    try { const result = await api.saveSettings(partial); if (result && typeof result === 'object') setSettings(result as Settings); }
    catch (error) { setSettings(previous); setNotice(displayError(error)); }
  }

  const filteredHistory = useMemo(() => history.filter(item => {
    const matchesSearch = `${item.programName} ${item.title} ${episodeCode(item)}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (historyFilter === 'all' || String(item.programId) === historyFilter);
  }), [history, search, historyFilter]);
  const historyPrograms = useMemo(() => [...new Map(history.map(item => [item.programId, item.programName] as const)).entries()], [history]);
  const eligiblePrograms = library.programs.filter(program => program.eligible).length;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand" aria-label="Mystery Channel"><div className="brand-mark"><span /></div><span className="brand-name">MYSTERY<br /><strong>CHANNEL</strong></span></div>
      <nav className="primary-nav" aria-label="Primary">
        {([['watch', 'Watch', 'play'], ['library', 'Library', 'library'], ['history', 'History', 'history']] as const).map(([id, label, icon]) =>
          <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span></button>)}
      </nav>
      <div className="sidebar-bottom"><div className="channel-status"><span className="status-dot" /> YOUR PERSONAL CHANNEL</div><button className="nav-item settings-link" onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>Settings</span></button></div>
    </aside>

    <main className="main-content">
      {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="close" size={16} /></button></div>}
      {!api && <div className="notice error" role="alert">Open Mystery Channel as a desktop app to connect to your local library.</div>}

      {page === 'watch' && <section className="watch-page" aria-labelledby="watch-heading">
        <div className="topline"><span className="eyebrow"><span className="live-dot" /> YOUR CHANNEL IS READY</span><span className="topline-right">A little mystery. The right order.</span></div>
        <div className="watch-hero">
          <div className="hero-glow" />
          <div className="hero-content">
            <div className="hero-kicker"><Icon name="shuffle" size={18} /> THE NEXT SHOW IS A SURPRISE</div>
            <h1 id="watch-heading">Your shows.<br /><em>A new order every time.</em></h1>
            <p>Pick up exactly where you left off in every programme. Let the channel decide which one is next.</p>
            {dashboard.lastWatched && <div className="recent-watch"><span className="recent-mark"><Icon name="check" size={13} /></span><span><small>LAST COMPLETED</small><strong>{dashboard.lastWatched.programName} · {episodeCode(dashboard.lastWatched)}</strong></span></div>}
            {dashboard.hasLibrary ? <div className="hero-actions"><button className="button primary hero-play" disabled={!api || !!busy || dashboard.counts.unwatchedEpisodes === 0} onClick={() => void chooseNext()}><Icon name="play" size={22} />{busy === 'choose' ? 'Choosing…' : 'Play Something'}<Icon name="arrow" size={18} /></button>{dashboard.resumeEpisode && <button className="button secondary" onClick={() => openEpisode(dashboard.resumeEpisode!)} disabled={!dashboard.resumeEpisode.available}><Icon name="play" size={16} /> Resume</button>}</div> : <button className="button primary hero-play" onClick={() => void addFolder()} disabled={!api || !!busy}><Icon name="folder" /> Choose Library Folder <Icon name="arrow" size={18} /></button>}
            {!dashboard.hasLibrary && <div className="empty-hint">Choose a folder containing your show folders. We’ll find the episodes and keep their place.</div>}
            {dashboard.hasLibrary && dashboard.counts.unwatchedEpisodes === 0 && <div className="empty-hint">All caught up. Add more episodes or programmes in Library.</div>}
          </div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="art-core"><Icon name="play" size={38} /></div><div className="art-caption">MYSTERY<br />CHANNEL</div></div>
        </div>
        <div className="watch-lower">
          <div className="section-heading"><div><span className="eyebrow">AT A GLANCE</span><h2>The channel so far</h2></div></div>
          <div className="stats-grid"><div className="stat-card"><span>PROGRAMMES</span><strong>{dashboard.counts.programs}</strong><small>in your library</small></div><div className="stat-card"><span>READY TO WATCH</span><strong>{dashboard.counts.unwatchedEpisodes}</strong><small>episodes left</small></div><div className="stat-card last-card"><span>LAST COMPLETED</span><strong className="last-title">{dashboard.lastWatched?.programName ?? 'Nothing yet'}</strong><small>{dashboard.lastWatched ? `${episodeCode(dashboard.lastWatched)}${dashboard.lastWatched.title ? ` · ${dashboard.lastWatched.title}` : ''}` : 'Your watch history starts here'}</small></div></div>
          {dashboard.resumeEpisode && <div className="continue-card"><div className="continue-icon"><Icon name="play" /></div><div><span className="eyebrow">CONTINUE WATCHING</span><h3>{dashboard.resumeEpisode.programName}</h3><p>{episodeCode(dashboard.resumeEpisode)} · {dashboard.resumeEpisode.title || 'Untitled episode'} · {time(dashboard.resumeEpisode.positionSeconds)} in</p></div><button className="button text-button" onClick={() => openEpisode(dashboard.resumeEpisode!)} disabled={!dashboard.resumeEpisode.available}>Resume <Icon name="arrow" size={16} /></button></div>}
        </div>
      </section>}

      {page === 'library' && <section className="content-page" aria-labelledby="library-heading"><header className="page-header"><div><span className="eyebrow">YOUR COLLECTION</span><h1 id="library-heading">Library</h1><p>Every programme in its own order, ready whenever you are.</p></div><div className="header-actions"><button className="button secondary" onClick={() => void scan()} disabled={!api || !!busy}><Icon name="refresh" size={17} />{busy === 'scan' ? 'Scanning…' : 'Rescan'}</button><button className="button primary" onClick={() => void addFolder()} disabled={!api || !!busy}><Icon name="plus" size={18} /> Add folder</button></div></header>
        <div className="folder-strip"><Icon name="folder" size={18} /><span>{library.folders.length ? `${library.folders.length} library ${library.folders.length === 1 ? 'folder' : 'folders'}` : 'No library folders yet'}</span><button className="folder-path-button" onClick={() => setManualFolderOpen(true)}>Enter path</button></div>
        {library.folders.length > 0 && <div className="library-folder-list" aria-label="Library folders">{library.folders.map(folder => <div className={`library-folder-row ${folder.excluded ? 'is-excluded' : ''}`} key={folder.id}><Icon name="folder" size={17} /><div className="library-folder-info"><strong title={folder.path}>{folder.path}</strong><small>{folder.excluded ? 'Excluded from random picks · still monitored' : 'Included in random picks · monitored'}</small></div><div className="library-folder-actions"><button className="button ghost small" aria-label={`${folder.excluded ? 'Include' : 'Exclude'} folder ${folder.path} ${folder.excluded ? 'in' : 'from'} random picks`} onClick={() => void setExcluded('folder', folder.id, !folder.excluded)} disabled={!api || !!busy}>{folder.excluded ? 'Include' : 'Exclude'}</button><button className="button ghost small danger-button" aria-label={`Remove library folder ${folder.path}`} onClick={() => setFolderToRemove(folder)} disabled={!api || !!busy}>Remove folder</button></div></div>)}</div>}
        {library.programs.length === 0 ? <div className="page-empty"><div className="empty-icon"><Icon name="library" size={32} /></div><h2>Your library starts with a folder.</h2><p>Choose a folder where you keep your programmes. Show folders and episodes will appear here automatically.</p><button className="button primary" onClick={() => void addFolder()} disabled={!api || !!busy}>Choose Library Folder</button></div> : <div className="program-list">{library.programs.map(program => <div className={`program-card ${program.excluded ? 'is-excluded' : ''}`} key={program.id}><div className="program-row"><button className="program-toggle" aria-expanded={expandedProgram === program.id} onClick={() => setExpandedProgram(expandedProgram === program.id ? null : program.id)}><div className="program-poster">{program.name.slice(0, 1).toUpperCase()}</div><div className="program-info"><h2>{program.name} {program.excluded && <span className="exclusion-badge">Excluded</span>}</h2><p>{program.episodes.length} {program.episodes.length === 1 ? 'episode' : 'episodes'} <span className="bullet">·</span> {program.unwatchedCount} unwatched{program.needsReviewCount > 0 && <> <span className="bullet">·</span> <span className="review-text">{program.needsReviewCount} need review</span></>}</p></div><Icon name="chevron" size={19} /></button><button className="button ghost small" aria-label={`${program.excluded ? 'Include' : 'Exclude'} programme ${program.name} ${program.excluded ? 'in' : 'from'} random picks`} onClick={() => void setExcluded('program', program.id, !program.excluded)} disabled={!api || !!busy}>{program.excluded ? 'Include' : 'Exclude'}</button><button className="button ghost small" onClick={() => void openRenamer(program)} disabled={!api || !!busy}>Organize files</button></div>{expandedProgram === program.id && <div className="episode-list">{program.episodes.map(episode => <div className={`episode-row ${episode.excluded ? 'is-excluded' : ''}`} key={episode.id}><div className={`episode-status ${episode.completed ? 'done' : ''}`}><Icon name={episode.completed ? 'check' : 'play'} size={13} /></div><div className="episode-info"><strong>{episodeCode(episode)} <span>{episode.title || 'Untitled episode'}</span> {episode.excluded && <span className="exclusion-badge">Excluded</span>}</strong><small>{episode.excluded ? 'Excluded from random picks · progress kept' : !episode.available ? 'File unavailable' : episode.needsReview ? 'Check episode order' : episode.completed ? 'Watched' : episode.positionSeconds > 0 ? `Resume at ${time(episode.positionSeconds)}` : 'Ready to watch'}</small></div><div className="episode-actions"><button className={`button ghost small ${episode.needsReview ? 'needs-review' : ''}`} onClick={() => editEpisode(episode)}>Edit order</button><button className="button ghost small" aria-label={`${episode.excluded ? 'Include' : 'Exclude'} ${episodeName(episode)} ${episode.excluded ? 'in' : 'from'} random picks`} onClick={() => void setExcluded('episode', episode.id, !episode.excluded)} disabled={!api || !!busy}>{episode.excluded ? 'Include' : 'Exclude'}</button><button className="button ghost small" onClick={() => openEpisode(episode)} disabled={!episode.available}>Play</button><button className="button ghost small" onClick={() => void markEpisode(episode, !episode.completed)} disabled={!!busy}>{episode.completed ? 'Mark unwatched' : 'Mark watched'}</button></div></div>)}</div>}</div>)}</div>}
        <div className="library-footer">{eligiblePrograms} {eligiblePrograms === 1 ? 'programme' : 'programmes'} eligible for the next pick. Missing files keep their progress.</div>
      </section>}

      {page === 'history' && <section className="content-page" aria-labelledby="history-heading"><header className="page-header"><div><span className="eyebrow">YOUR WATCH LOG</span><h1 id="history-heading">History</h1><p>Every episode has its place. Correct a mistake whenever you need to.</p></div><button className="button secondary" onClick={() => api && void run('undo', async () => { await api.undoLastCompletion(); await reload(); }, 'Last completion undone.')} disabled={!api || !!busy || history.length === 0}><Icon name="back" size={16} /> Undo last completion</button></header><div className="history-toolbar"><label className="search-box"><Icon name="search" size={18} /><span className="sr-only">Search history</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search programmes or episodes" /></label><label className="filter-box"><span className="sr-only">Filter by programme</span><select value={historyFilter} onChange={event => setHistoryFilter(event.target.value)}><option value="all">All programmes</option>{historyPrograms.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label></div>{filteredHistory.length === 0 ? <div className="page-empty compact"><div className="empty-icon"><Icon name="history" size={30} /></div><h2>{history.length ? 'No matching episodes' : 'The story starts here.'}</h2><p>{history.length ? 'Try another search or programme.' : 'Your watched and partly watched episodes will appear here.'}</p></div> : <div className="history-list">{filteredHistory.map(item => <div className="history-row" key={`${item.id}-${item.watchedAt}`}><div className={`episode-status ${item.status === 'completed' ? 'done' : ''}`}><Icon name={item.status === 'completed' ? 'check' : 'play'} size={14} /></div><div className="history-info"><strong>{item.programName}</strong><span>{episodeCode(item)} · {item.title || 'Untitled episode'}</span></div><div className="history-meta"><span>{item.status === 'completed' ? 'Completed' : `In progress · ${time(item.positionSeconds)}`}</span><small>{date(item.watchedAt)}</small></div><button className="button ghost small" onClick={() => void markEpisode(item, item.status !== 'completed')} disabled={!!busy}>{item.status === 'completed' ? 'Mark unwatched' : 'Mark watched'}</button></div>)}</div>}</section>}
    </main>

    {playerOpen && activeEpisode && <div className="modal-backdrop player-backdrop" role="presentation"><div className="player-dialog" role="dialog" aria-modal="true" aria-label={`Playing ${episodeName(activeEpisode)}`}><div className="player-head"><div><span className="eyebrow">NOW PLAYING</span><h2>{activeEpisode.programName}</h2><p>{episodeCode(activeEpisode)} · {activeEpisode.title || 'Untitled episode'}</p></div><button className="icon-button" aria-label="Close player" onClick={() => void closePlayer()}><Icon name="close" /></button></div><video ref={videoRef} className="video-player" src={activeEpisode.mediaUrl} controls autoPlay playsInline onLoadedMetadata={event => { if (!resumeSeekRef.current && activeEpisode.positionSeconds > 0) { event.currentTarget.currentTime = activeEpisode.positionSeconds; resumeSeekRef.current = true; } }} onTimeUpdate={() => { void saveProgress(); }} onPause={() => { void saveProgress(true); }} onEnded={() => { void finishEpisode(); }} onError={() => setNotice('This format could not be played inside Mystery Channel. You can open it in your default video player.')} /><div className="player-footer"><span>Episodes stay in order, even when the programme changes.</span><div><button className="button ghost" onClick={() => api && void run('external-player', () => api.openExternalPlayer(activeEpisode.id), 'Opened in your default video player.')} disabled={!api || !!busy}>Open externally</button><button className="button ghost" onClick={() => void closePlayer(true)}>Choose another programme</button><button className="button secondary" onClick={() => void finishEpisode()} disabled={!!busy}>Mark watched</button></div></div></div></div>}

    {folderToRemove && <div className="modal-backdrop" role="presentation"><div className="dialog remove-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-folder-heading" aria-describedby="remove-folder-description"><div className="dialog-head"><div><span className="eyebrow">LIBRARY FOLDER</span><h2 id="remove-folder-heading">Remove this folder?</h2><p className="remove-folder-path">{folderToRemove.path}</p></div><button className="icon-button" aria-label="Cancel folder removal" onClick={() => setFolderToRemove(null)} disabled={!!busy}><Icon name="close" /></button></div><p className="remove-folder-description" id="remove-folder-description">Mystery Channel will stop monitoring this folder. No media files or watch history will be deleted. You can add the folder again later to restore monitoring.</p><div className="dialog-actions"><button className="button ghost" onClick={() => setFolderToRemove(null)} disabled={!!busy}>Cancel</button><button className="button secondary danger-button" onClick={() => void removeFolder()} disabled={!api || !!busy}>{busy === 'remove-folder' ? 'Removing…' : 'Remove folder'}</button></div></div></div>}

    {manualFolderOpen && <div className="modal-backdrop" role="presentation"><form className="dialog manual-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-heading" onSubmit={event => { event.preventDefault(); void addManualFolder(); }}><div className="dialog-head"><div><span className="eyebrow">ADD A FOLDER</span><h2 id="manual-heading">Enter a folder path</h2><p>Use this when you already know where your programmes are stored.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setManualFolderOpen(false)}><Icon name="close" /></button></div><div className="manual-body"><label htmlFor="manual-path">Folder path</label><input id="manual-path" autoFocus value={manualPath} onChange={event => setManualPath(event.target.value)} placeholder="C:\\Videos\\Shows" /></div><div className="dialog-actions"><button type="button" className="button ghost" onClick={() => setManualFolderOpen(false)}>Cancel</button><button type="submit" className="button primary" disabled={!manualPath.trim() || !!busy}>Add folder</button></div></form></div>}

    {editingEpisode && <div className="modal-backdrop" role="presentation"><form className="dialog edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-heading" onSubmit={event => { event.preventDefault(); void saveEpisode(); }}><div className="dialog-head"><div><span className="eyebrow">EPISODE ORDER</span><h2 id="edit-heading">Edit episode details</h2><p>{editingEpisode.programName} · {editingEpisode.filePath.split(/[\\/]/).pop()}</p></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setEditingEpisode(null)}><Icon name="close" /></button></div><div className="edit-body"><p>Set a season and episode number, or use an air date. This controls which episode plays next.</p><div className="edit-grid"><label>Season number<input type="number" min="0" step="1" value={episodeForm.season} onChange={event => setEpisodeForm({ ...episodeForm, season: event.target.value })} placeholder="1" /></label><label>Episode number<input type="number" min="1" step="1" value={episodeForm.episode} onChange={event => setEpisodeForm({ ...episodeForm, episode: event.target.value })} placeholder="1" /></label></div><label>Air date<input type="date" value={episodeForm.airDate} onChange={event => setEpisodeForm({ ...episodeForm, airDate: event.target.value })} /></label><label>Episode title<input type="text" value={episodeForm.title} onChange={event => setEpisodeForm({ ...episodeForm, title: event.target.value })} /></label></div><div className="dialog-actions"><button type="button" className="button ghost" onClick={() => setEditingEpisode(null)}>Cancel</button><button type="submit" className="button primary" disabled={!!busy}>{busy === 'edit-episode' ? 'Saving…' : 'Save order'}</button></div></form></div>}

    {renameProgram && <div className="modal-backdrop" role="presentation"><div className="dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading"><div className="dialog-head"><div><span className="eyebrow">ORGANIZE FILES</span><h2 id="rename-heading">{renameProgram.name}</h2><p>Review every new name before changing files.</p></div><button className="icon-button" aria-label="Close rename preview" onClick={() => setRenameProgram(null)}><Icon name="close" /></button></div>{renameWarnings.map((warning, index) => <div className="inline-warning" key={index}><Icon name="warning" size={16} />{warning}</div>)}<div className="rename-list">{renamePlans.length === 0 ? <p className="rename-empty">No safe rename suggestions found for this programme.</p> : renamePlans.map(plan => <label className={`rename-item ${plan.collision ? 'disabled' : ''}`} key={plan.id}><input type="checkbox" checked={selectedPlans.includes(plan.id)} disabled={plan.collision} onChange={event => setSelectedPlans(event.target.checked ? [...selectedPlans, plan.id] : selectedPlans.filter(id => id !== plan.id))} /><div><small>FROM</small><span>{plan.oldPath}</span><small>TO</small><strong>{plan.newPath}</strong><em className={plan.collision || plan.confidence.toLowerCase() !== 'high' ? 'caution' : ''}>{plan.collision ? 'Name collision — cannot apply' : `${plan.confidence} confidence`}</em></div></label>)}</div><div className="dialog-actions"><button className="button ghost" onClick={() => setRenameProgram(null)}>Cancel</button><button className="button primary" onClick={() => void applyRenames()} disabled={selectedPlans.length === 0 || !!busy}>{busy === 'rename' ? 'Renaming…' : `Rename ${selectedPlans.length} ${selectedPlans.length === 1 ? 'file' : 'files'}`}</button></div></div></div>}

    {settingsOpen && <div className="modal-backdrop" role="presentation"><div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-heading"><div className="dialog-head"><div><span className="eyebrow">PREFERENCES</span><h2 id="settings-heading">Settings</h2><p>Fine tune how your channel behaves.</p></div><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></div><div className="settings-body"><h3>Playback</h3><label className="setting-row"><span><strong>Autoplay the next pick</strong><small>Keep the channel going after an episode ends.</small></span><input type="checkbox" checked={settings.autoplay ?? true} onChange={event => void saveSetting({ autoplay: event.target.checked })} /></label><label className="setting-row"><span><strong>Avoid the same programme twice in a row</strong><small>When there is more than one eligible show.</small></span><input type="checkbox" checked={settings.avoidConsecutive ?? true} onChange={event => void saveSetting({ avoidConsecutive: event.target.checked })} /></label><label className="setting-row"><span><strong>Completion threshold</strong><small>Mark an episode watched after this much has played.</small></span><select value={settings.completionThreshold ?? 0.9} onChange={event => void saveSetting({ completionThreshold: Number(event.target.value) })}><option value={0.8}>80%</option><option value={0.9}>90%</option><option value={0.95}>95%</option><option value={1}>At the end</option></select></label><label className="setting-row"><span><strong>Randomness balance</strong><small>Higher values favour programmes not picked recently.</small></span><input aria-label="Randomness balance" type="range" min="0" max="1" step="0.1" value={settings.randomBalance ?? 0.5} onChange={event => void saveSetting({ randomBalance: Number(event.target.value) })} /></label><h3>Library and data</h3><div className="setting-row"><span><strong>Rescan library</strong><small>Find newly added or moved episodes.</small></span><button className="button secondary small" onClick={() => void scan()} disabled={!!busy}>Rescan</button></div><div className="setting-row"><span><strong>Back up viewing history</strong><small>Save a copy of your progress database.</small></span><button className="button secondary small" onClick={() => api && void run('backup', () => api.backupDatabase(), 'Backup saved.')} disabled={!api || !!busy}>Back up</button></div><div className="setting-row"><span><strong>Restore viewing history</strong><small>Choose a previous database backup.</small></span><button className="button secondary small" onClick={() => api && void run('restore', async () => { await api.restoreDatabase(); await reload(); }, 'Backup restored.')} disabled={!api || !!busy}>Restore</button></div><div className="setting-row"><span><strong>Undo last file rename</strong><small>Return files to their previous names.</small></span><button className="button secondary small" onClick={() => api && void run('undo-rename', async () => { await api.undoLastRename(); await reload(); }, 'Last rename undone.')} disabled={!api || !!busy}>Undo rename</button></div></div></div></div>}
  </div>;
}
