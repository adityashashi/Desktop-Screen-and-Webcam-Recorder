import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { v4 as uuidv4 } from "uuid";

type CreateSessionInput = { name?: string };
type SaveFileInput = { sessionId: string; fileName: "screen.webm" | "webcam.webm"; data: ArrayBuffer };
type OpenFolderInput = { sessionId: string };
type RenameSessionInput = { sessionId: string; name: string };
type SetVideosRootInput = { directoryPath: string };
type MergeSessionInput = { sessionId: string };

type SessionInfo = {
    id: string;
    name: string;
    createdAt: string;
};

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9 _-]{1,80}$/;
const ALLOWED_FILE_NAMES = new Set(["screen.webm", "webcam.webm"]);
const ffmpegPath = require("ffmpeg-static") as string | null;

let mainWindow: BrowserWindow | null = null;
let isForceClosing = false;
let configuredVideosRoot = process.env.RECORDER_VIDEOS_DIR
    ? path.resolve(process.env.RECORDER_VIDEOS_DIR)
    : path.resolve(process.cwd(), "videos");

function getVideosRoot() {
    return configuredVideosRoot;
}

async function setVideosRoot(directoryPath: string) {
    const resolved = path.resolve(directoryPath);
    await fs.mkdir(resolved, { recursive: true });
    configuredVideosRoot = resolved;
    return configuredVideosRoot;
}

function getSessionPath(sessionId: string) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw new Error("Invalid session id.");
    }
    const videosRoot = getVideosRoot();
    const sessionPath = path.resolve(videosRoot, sessionId);
    if (!sessionPath.startsWith(videosRoot)) {
        throw new Error("Invalid session path.");
    }
    return sessionPath;
}

function validateSessionName(name: string) {
    if (!SAFE_NAME_PATTERN.test(name)) {
        throw new Error("Session name must be 1-80 chars and contain only letters, numbers, spaces, _ or -.");
    }
}

async function writeFileAtomic(targetPath: string, content: Buffer) {
    const tmpPath = `${targetPath}.tmp-${Date.now()}`;
    const fileHandle = await fs.open(tmpPath, "w");
    try {
        await fileHandle.writeFile(content);
        await fileHandle.sync();
    } finally {
        await fileHandle.close();
    }
    await fs.rename(tmpPath, targetPath);
}

async function ensureVideosRoot() {
    await fs.mkdir(getVideosRoot(), { recursive: true });
}

async function fileExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function runFfmpeg(args: string[]) {
    return new Promise<void>((resolve, reject) => {
        if (!ffmpegPath) {
            reject(new Error("ffmpeg binary is unavailable on this platform."));
            return;
        }

        const processHandle = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        processHandle.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        processHandle.on("error", (error) => {
            reject(error);
        });

        processHandle.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `ffmpeg exited with code ${String(code)}`));
        });
    });
}

async function mergeSessionToFinalMp4(sessionId: string) {
    const sessionPath = getSessionPath(sessionId);
    const screenPath = path.join(sessionPath, "screen.webm");
    const webcamPath = path.join(sessionPath, "webcam.webm");
    const outputPath = path.join(sessionPath, "final.mp4");

    const hasScreen = await fileExists(screenPath);
    if (!hasScreen) {
        throw new Error("screen.webm not found for this session.");
    }

    const hasWebcam = await fileExists(webcamPath);

    const baseArgs = ["-y", "-i", screenPath];
    const args = hasWebcam
        ? [
            ...baseArgs,
            "-i",
            webcamPath,
            "-filter_complex",
            "[1:v]scale=iw*0.25:-1[cam];[0:v][cam]overlay=W-w-24:H-h-24",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-shortest",
            outputPath,
        ]
        : [
            ...baseArgs,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            outputPath,
        ];

    await runFfmpeg(args);
    return outputPath;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 1024,
        minHeight: 700,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });

    mainWindow.removeMenu();

    mainWindow.webContents.on("will-navigate", (event) => {
        event.preventDefault();
    });

    mainWindow.on("close", (event) => {
        if (isForceClosing || !mainWindow) {
            return;
        }

        event.preventDefault();

        const closePromise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 4000);
            ipcMain.once("app:before-close-ack", () => {
                clearTimeout(timeout);
                resolve();
            });
            mainWindow?.webContents.send("app:before-close");
        });

        void closePromise.finally(() => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return;
            }
            isForceClosing = true;
            mainWindow.close();
        });
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
        isForceClosing = false;
    });

    const indexPath = path.join(__dirname, "../renderer/index.html");
    void mainWindow.loadFile(indexPath);
}

app.whenReady().then(async () => {
    await ensureVideosRoot();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

ipcMain.handle("app:get-videos-root", async () => {
    await ensureVideosRoot();
    return getVideosRoot();
});

ipcMain.handle("app:set-videos-root", async (_event, payload: SetVideosRootInput) => {
    if (!payload?.directoryPath?.trim()) {
        throw new Error("Directory path is required.");
    }
    const root = await setVideosRoot(payload.directoryPath.trim());
    return { directoryPath: root };
});

ipcMain.handle("app:pick-save-directory", async () => {
    const result = await dialog.showOpenDialog({
        title: "Choose recording save folder",
        properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { directoryPath: null as string | null };
    }

    const root = await setVideosRoot(result.filePaths[0]);
    return { directoryPath: root };
});

ipcMain.handle("capture:list-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 360, height: 220 },
        fetchWindowIcons: false,
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.toDataURL(),
        displayId: source.display_id,
    }));
});

ipcMain.handle("session:create", async (_event, payload: CreateSessionInput) => {
    await ensureVideosRoot();

    const id = uuidv4();
    const name = (payload?.name ?? "Untitled Session").trim();
    if (name) {
        validateSessionName(name);
    }

    const sessionPath = getSessionPath(id);
    await fs.mkdir(sessionPath, { recursive: false });

    const metadata: SessionInfo = {
        id,
        name: name || "Untitled Session",
        createdAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(sessionPath, "session.json"), JSON.stringify(metadata, null, 2), "utf8");

    return { sessionId: id, sessionPath };
});

ipcMain.handle("session:rename", async (_event, payload: RenameSessionInput) => {
    const sessionPath = getSessionPath(payload.sessionId);
    const name = payload.name.trim();
    validateSessionName(name);

    const metadataPath = path.join(sessionPath, "session.json");
    const existingRaw = await fs.readFile(metadataPath, "utf8");
    const existing = JSON.parse(existingRaw) as SessionInfo;

    const updated: SessionInfo = {
        ...existing,
        name,
    };

    await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2), "utf8");
    return { success: true };
});

ipcMain.handle("recording:save-file", async (_event, payload: SaveFileInput) => {
    if (!ALLOWED_FILE_NAMES.has(payload.fileName)) {
        throw new Error("Invalid file name.");
    }

    const sessionPath = getSessionPath(payload.sessionId);
    const targetPath = path.join(sessionPath, payload.fileName);
    const targetResolved = path.resolve(targetPath);

    if (!targetResolved.startsWith(sessionPath)) {
        throw new Error("Resolved path outside session directory.");
    }

    const buffer = Buffer.from(payload.data);
    await writeFileAtomic(targetResolved, buffer);

    return { success: true, path: targetResolved };
});

ipcMain.handle("session:open-folder", async (_event, payload: OpenFolderInput) => {
    const folderPath = getSessionPath(payload.sessionId);
    const result = await shell.openPath(folderPath);

    if (result) {
        throw new Error(`Unable to open folder: ${result}`);
    }

    return { success: true };
});

ipcMain.handle("session:merge-final-mp4", async (_event, payload: MergeSessionInput) => {
    if (!payload?.sessionId) {
        throw new Error("Session id is required.");
    }

    const outputPath = await mergeSessionToFinalMp4(payload.sessionId);
    return { success: true, path: outputPath };
});
