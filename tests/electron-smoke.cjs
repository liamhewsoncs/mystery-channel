const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packagedBinary = process.env.MYSTERY_CHANNEL_BINARY;
const electronPath = packagedBinary || require("electron");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mystery-channel-smoke-"));
const artifactsDirectory = path.join(root, "artifacts");
const screenshotPath = path.join(artifactsDirectory, "smoke-watch.png");
const libraryScreenshotPath = path.join(artifactsDirectory, "smoke-library.png");
const debugPort = 9333;
fs.mkdirSync(artifactsDirectory, { recursive: true });
const syntheticLibrary = path.join(dataDirectory, "Synthetic Library");
const fixtureVideo = path.join(dataDirectory, "fixture.mp4");
const ffmpeg = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=1.2",
  "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixtureVideo
], { encoding: "utf8" });
if (ffmpeg.status !== 0) throw new Error(`Could not create the playback fixture with FFmpeg: ${ffmpeg.stderr}`);
for (const programme of ["Alpha", "Beta"]) {
  const programmeDirectory = path.join(syntheticLibrary, programme);
  fs.mkdirSync(programmeDirectory, { recursive: true });
  fs.copyFileSync(fixtureVideo, path.join(programmeDirectory, `${programme}.S01E02.Second.mp4`));
  fs.copyFileSync(fixtureVideo, path.join(programmeDirectory, `${programme}.S01E01.First.mp4`));
}

const childEnvironment = { ...process.env, MYSTERY_CHANNEL_DATA_DIR: dataDirectory };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const childArguments = packagedBinary ? [`--remote-debugging-port=${debugPort}`] : [root, `--remote-debugging-port=${debugPort}`];
const child = spawn(electronPath, childArguments, {
  cwd: root,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let processOutput = "";
child.stdout.on("data", (chunk) => { processOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { processOutput += chunk.toString(); });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getPageTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}).\n${processOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.title === "Mystery Channel") ||
        targets.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch { /* The debugging endpoint is not ready yet. */ }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the Electron page.\n${processOutput}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Could not connect to Electron DevTools."));
  });
  return {
    ready,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

async function run() {
  let cdp;
  try {
    const target = await getPageTarget();
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await delay(600);
    const evaluation = await cdp.call("Runtime.evaluate", {
      expression: `(() => ({
        title: document.title,
        text: document.body.innerText,
        primaryNavigation: [...document.querySelectorAll('.nav-item')].map((item) => item.textContent.trim()),
        visibleButtons: [...document.querySelectorAll('button')].filter((item) => item.offsetParent !== null).map((item) => item.textContent.trim())
      }))()`,
      returnByValue: true
    });
    const state = evaluation.result.value;
    if (state.title !== "Mystery Channel") throw new Error(`Unexpected window title: ${state.title}`);
    for (const label of ["Watch", "Library", "History"]) {
      if (!state.primaryNavigation.some((item) => item.includes(label))) throw new Error(`Missing primary navigation item: ${label}`);
    }
    if (!state.text.toLocaleLowerCase().includes("choose library folder")) throw new Error("The empty-library action is not visible.");
    const screenshot = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

    const integration = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const api = window.mysteryChannel;
        await api.addLibraryFolder(${JSON.stringify(syntheticLibrary)});
        const library = await api.listLibrary();
        const first = await api.chooseNext();
        await api.markWatched(first.id);
        const second = await api.chooseNext();
        await api.markWatched(second.id);
        const third = await api.chooseNext();
        await api.updateProgress({ episodeId: third.id, positionSeconds: 0.25, durationSeconds: 1.2 });
        const resume = (await api.getDashboard()).resumeEpisode;
        const fourth = await api.chooseNext();
        const playback = await new Promise((resolve, reject) => {
          const video = document.createElement('video');
          video.muted = true;
          video.src = fourth.mediaUrl;
          video.style.display = 'none';
          document.body.append(video);
          const timeout = setTimeout(() => reject(new Error('Playback timed out')), 8000);
          video.onerror = () => reject(new Error('Synthetic MP4 could not be decoded'));
          video.onloadedmetadata = async () => {
            try { video.currentTime = Math.min(0.2, video.duration / 3); await video.play(); }
            catch (error) { reject(error); }
          };
          video.onended = () => { clearTimeout(timeout); resolve({ duration: video.duration, endedAt: video.currentTime }); video.remove(); };
        });
        const completed = await api.updateProgress({ episodeId: fourth.id, positionSeconds: playback.duration, durationSeconds: playback.duration });
        await api.setExcluded({ kind: 'program', id: third.programId, excluded: true });
        const blockedByProgram = await api.chooseNext();
        await api.setExcluded({ kind: 'program', id: third.programId, excluded: false });
        const restoredProgram = await api.chooseNext();
        const folderId = library.folders[0].id;
        await api.setExcluded({ kind: 'folder', id: folderId, excluded: true });
        const blockedByFolder = await api.chooseNext();
        await api.setExcluded({ kind: 'folder', id: folderId, excluded: false });
        await api.setExcluded({ kind: 'episode', id: third.id, excluded: true });
        const blockedByEpisode = await api.chooseNext();
        await api.setExcluded({ kind: 'episode', id: third.id, excluded: false });
        return {
          programmes: library.programs.map((item) => ({ name: item.name, episodes: item.episodes.map((episode) => episode.episodeNumber) })),
          selections: [first, second, third].map((episode) => ({ programName: episode.programName, episodeNumber: episode.episodeNumber })),
          resume: { id: resume && resume.id, expectedId: third.id, positionSeconds: resume && resume.positionSeconds },
          playback: { ...playback, completed: completed.completed },
          exclusions: {
            programBlocked: blockedByProgram === null,
            programRestored: restoredProgram && restoredProgram.id === third.id,
            folderBlocked: blockedByFolder === null,
            episodeBlocked: blockedByEpisode === null
          }
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const integrationState = integration.result.value;
    if (integrationState.programmes.length !== 2) throw new Error("The watched-folder scan did not find both programmes.");
    if (integrationState.programmes.some((item) => item.episodes.join(",") !== "1,2")) throw new Error("Episodes were not sorted chronologically.");
    const [first, second, third] = integrationState.selections;
    if (first.episodeNumber !== 1 || second.episodeNumber !== 1 || third.episodeNumber !== 2) throw new Error("Selection skipped chronological episode order.");
    if (first.programName === second.programName || first.programName !== third.programName) throw new Error("Consecutive programme avoidance did not behave as expected.");
    if (integrationState.resume.id !== integrationState.resume.expectedId || integrationState.resume.positionSeconds !== 0.25) throw new Error("Partial playback did not become the resumable episode.");
    if (!integrationState.playback.completed || integrationState.playback.endedAt < integrationState.playback.duration * 0.9) throw new Error("Real MP4 playback or completion tracking failed.");
    if (!Object.values(integrationState.exclusions).every(Boolean)) throw new Error("Folder, programme, or episode exclusion did not update the random queue correctly.");
    await delay(600);
    await cdp.call("Runtime.evaluate", {
      expression: `(() => { const button = [...document.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('Library')); button.click(); return true; })()`,
      returnByValue: true
    });
    await delay(300);
    const libraryControls = await cdp.call("Runtime.evaluate", {
      expression: `(() => [...document.querySelectorAll('button')].filter((item) => item.offsetParent !== null).map((item) => item.textContent.trim()))()`,
      returnByValue: true
    });
    if (!libraryControls.result.value.includes("Remove folder") || !libraryControls.result.value.includes("Exclude")) throw new Error("The Library exclusion controls are not visible.");
    const libraryScreenshot = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(libraryScreenshotPath, Buffer.from(libraryScreenshot.data, "base64"));
    const removal = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const api = window.mysteryChannel;
        const before = await api.listLibrary();
        const historyBefore = await api.listHistory();
        await api.removeLibraryFolder(before.folders[0].id);
        const removed = await api.listLibrary();
        const historyAfter = await api.listHistory();
        await api.addLibraryFolder(${JSON.stringify(syntheticLibrary)});
        const restored = await api.listLibrary();
        return {
          hiddenAfterRemoval: removed.folders.length === 0 && removed.programs.length === 0,
          historyPreserved: historyAfter.length === historyBefore.length,
          restoredAfterReAdd: restored.folders.length === 1 && restored.programs.length === 2
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (!Object.values(removal.result.value).every(Boolean)) throw new Error("Removing and re-adding a watched folder did not preserve its state correctly.");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      screenshotPath,
      libraryScreenshotPath,
      primaryNavigation: state.primaryNavigation,
      integration: integrationState,
      removal: removal.result.value
    }, null, 2)}\n`);
    await cdp.call("Browser.close").catch(() => {});
  } finally {
    cdp?.close();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3000).then(() => { if (child.exitCode === null) child.kill(); })
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n${processOutput}`);
  if (child.exitCode === null) child.kill();
  process.exitCode = 1;
});
