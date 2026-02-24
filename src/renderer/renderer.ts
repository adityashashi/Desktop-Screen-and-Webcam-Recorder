type CaptureSource = {
    id: string;
    name: string;
    thumbnailDataUrl: string;
    displayId: string;
};

type ActiveSession = {
    sessionId: string;
    sessionPath: string;
};

const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

function requireElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) {
        throw new Error(`UI initialization failed. Missing element: ${selector}`);
    }
    return element;
}

const sourceGrid = requireElement<HTMLDivElement>("#sourceGrid");
const statusEl = requireElement<HTMLParagraphElement>("#status");
const timerEl = requireElement<HTMLSpanElement>("#timer");
const sessionNameInput = requireElement<HTMLInputElement>("#sessionName");
const bitrateSelect = requireElement<HTMLSelectElement>("#bitrateSelect");
const chooseSaveDirBtn = requireElement<HTMLButtonElement>("#chooseSaveDirBtn");
const saveDirLabel = requireElement<HTMLSpanElement>("#saveDirLabel");
const webcamToggle = requireElement<HTMLInputElement>("#webcamToggle");
const refreshBtn = requireElement<HTMLButtonElement>("#refreshBtn");
const startBtn = requireElement<HTMLButtonElement>("#startBtn");
const stopBtn = requireElement<HTMLButtonElement>("#stopBtn");
const stopWebcamBtn = requireElement<HTMLButtonElement>("#stopWebcamBtn");
const screenPreview = requireElement<HTMLVideoElement>("#screenPreview");
const webcamPreview = requireElement<HTMLVideoElement>("#webcamPreview");
const completeCard = requireElement<HTMLElement>("#completeCard");
const completeText = requireElement<HTMLParagraphElement>("#completeText");
const openFolderBtn = requireElement<HTMLButtonElement>("#openFolderBtn");
const renameSessionBtn = requireElement<HTMLButtonElement>("#renameSessionBtn");

let selectedSourceId: string | null = null;
let sources: CaptureSource[] = [];
let session: ActiveSession | null = null;

let screenStream: MediaStream | null = null;
let webcamStream: MediaStream | null = null;
let screenRecorder: MediaRecorder | null = null;
let webcamRecorder: MediaRecorder | null = null;

let screenChunks: Blob[] = [];
let webcamChunks: Blob[] = [];

let recordingStartAt = 0;
let timerInterval: number | null = null;
let maxDurationTimeout: number | null = null;
let isRecording = false;
let isStarting = false;
let isStopping = false;
let currentMimeType = "video/webm";
let selectedBitrate = 2_500_000;
let selectedSaveDir: string | null = null;
let isAppClosing = false;

function setStatus(message: string, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
}

function compactPath(pathValue: string) {
    if (pathValue.length <= 42) {
        return pathValue;
    }
    return `${pathValue.slice(0, 20)}...${pathValue.slice(-18)}`;
}

function renderSaveDirLabel() {
    if (!selectedSaveDir) {
        saveDirLabel.textContent = "videos/ (default)";
        saveDirLabel.title = "videos/ (default)";
        return;
    }
    saveDirLabel.textContent = compactPath(selectedSaveDir);
    saveDirLabel.title = selectedSaveDir;
}

function formatDuration(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
}

function startTimer() {
    stopTimer();
    recordingStartAt = Date.now();
    timerEl.textContent = "00:00:00";
    timerInterval = window.setInterval(() => {
        timerEl.textContent = formatDuration(Date.now() - recordingStartAt);
    }, 1000);

    maxDurationTimeout = window.setTimeout(() => {
        void stopRecording("Reached max recording duration (2 hours).");
    }, MAX_DURATION_MS);
}

function stopTimer() {
    if (timerInterval !== null) {
        window.clearInterval(timerInterval);
        timerInterval = null;
    }
    if (maxDurationTimeout !== null) {
        window.clearTimeout(maxDurationTimeout);
        maxDurationTimeout = null;
    }
}

function pickMimeType() {
    const candidates = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
}

async function listSources() {
    setStatus("Loading available screens/windows...");
    try {
        sources = await window.recorderApi.listSources();
        renderSources();

        if (!sources.length) {
            selectedSourceId = null;
            setStatus("No screen/window sources available.", true);
            return;
        }

        if (!selectedSourceId || !sources.some((item) => item.id === selectedSourceId)) {
            selectedSourceId = sources[0].id;
        }

        renderSources();
        await refreshScreenPreview();
        setStatus("Ready.");
    } catch (error) {
        setStatus(`Failed to load capture sources: ${toError(error)}`, true);
    }
}

function renderSources() {
    sourceGrid.innerHTML = "";

    for (const source of sources) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = `source-card ${source.id === selectedSourceId ? "active" : ""}`;
        card.onclick = async () => {
            selectedSourceId = source.id;
            renderSources();
            await refreshScreenPreview();
        };

        const img = document.createElement("img");
        img.className = "source-thumb";
        img.alt = source.name;
        img.src = source.thumbnailDataUrl;

        const name = document.createElement("div");
        name.className = "source-name";
        name.textContent = source.name;

        card.appendChild(img);
        card.appendChild(name);
        sourceGrid.appendChild(card);
    }
}

function stopStream(stream: MediaStream | null) {
    if (!stream) {
        return;
    }
    for (const track of stream.getTracks()) {
        track.stop();
    }
}

async function getScreenStream(sourceId: string) {
    const constraints = {
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: sourceId,
                maxWidth: 3840,
                maxHeight: 2160,
                maxFrameRate: 30,
            },
        } as MediaTrackConstraints,
    } as MediaStreamConstraints;

    return navigator.mediaDevices.getUserMedia(constraints);
}

async function refreshScreenPreview() {
    if (!selectedSourceId) {
        return;
    }

    stopStream(screenStream);
    screenStream = await getScreenStream(selectedSourceId);
    screenPreview.srcObject = screenStream;
}

async function ensureWebcamPreview() {
    if (!webcamToggle.checked) {
        stopStream(webcamStream);
        webcamStream = null;
        webcamPreview.srcObject = null;
        return;
    }

    stopStream(webcamStream);
    webcamStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    webcamPreview.srcObject = webcamStream;
}

function recorderStopPromise(recorder: MediaRecorder) {
    return new Promise<void>((resolve) => {
        if (recorder.state === "inactive") {
            resolve();
            return;
        }
        recorder.addEventListener("stop", () => resolve(), { once: true });
        try {
            recorder.requestData();
        } catch {
            // no-op
        }
        recorder.stop();
    });
}

function setButtons() {
    const busy = isRecording || isStarting || isStopping;
    startBtn.disabled = busy;
    refreshBtn.disabled = busy;
    webcamToggle.disabled = busy;
    bitrateSelect.disabled = busy;
    chooseSaveDirBtn.disabled = busy;
    stopBtn.disabled = !isRecording || isStopping;
    stopWebcamBtn.disabled = !isRecording || !webcamRecorder || webcamRecorder.state === "inactive";
}

async function startRecording() {
    if (isRecording || isStarting || isStopping) {
        return;
    }

    if (!selectedSourceId) {
        setStatus("Select a screen/window source first.", true);
        return;
    }

    isStarting = true;
    setButtons();

    completeCard.classList.add("hidden");

    try {
        const sessionName = sessionNameInput.value.trim() || "Untitled Session";
        selectedBitrate = Number.parseInt(bitrateSelect.value, 10);
        session = await window.recorderApi.createSession(sessionName);

        await refreshScreenPreview();

        if (webcamToggle.checked) {
            try {
                await ensureWebcamPreview();
            } catch (error) {
                setStatus(`Webcam unavailable. Continuing with screen only: ${toError(error)}`, true);
                webcamToggle.checked = false;
                stopStream(webcamStream);
                webcamStream = null;
                webcamPreview.srcObject = null;
            }
        }

        if (!screenStream) {
            throw new Error("Screen stream could not be initialized.");
        }

        const mimeType = pickMimeType();
        currentMimeType = mimeType;
        screenChunks = [];
        webcamChunks = [];

        screenRecorder = new MediaRecorder(screenStream, { mimeType, videoBitsPerSecond: selectedBitrate });
        screenRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                screenChunks.push(event.data);
            }
        };
        screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
            if (isRecording) {
                void stopRecording("Capture source ended.");
            }
        });

        if (webcamToggle.checked && webcamStream) {
            const webcamBitrate = Math.max(800_000, Math.floor(selectedBitrate * 0.8));
            webcamRecorder = new MediaRecorder(webcamStream, { mimeType, videoBitsPerSecond: webcamBitrate });
            webcamRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    webcamChunks.push(event.data);
                }
            };
        } else {
            webcamRecorder = null;
        }

        screenRecorder.start(1000);
        webcamRecorder?.start(1000);

        isRecording = true;
        startTimer();
        setStatus("Recording started.");
    } catch (error) {
        isRecording = false;
        stopTimer();
        setStatus(`Unable to start recording: ${toError(error)}`, true);
    } finally {
        isStarting = false;
        setButtons();
    }
}

async function saveBlob(sessionId: string, fileName: "screen.webm" | "webcam.webm", blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    await window.recorderApi.saveRecordingFile(sessionId, fileName, arrayBuffer);
}

async function stopRecording(reason?: string) {
    if (!isRecording || isStopping) {
        return;
    }

    isStopping = true;
    const durationMs = Math.max(1, Date.now() - recordingStartAt);
    isRecording = false;
    stopTimer();
    setButtons();

    try {
        const pendingStops: Promise<void>[] = [];
        if (screenRecorder && screenRecorder.state !== "inactive") {
            pendingStops.push(recorderStopPromise(screenRecorder));
        }
        if (webcamRecorder && webcamRecorder.state !== "inactive") {
            pendingStops.push(recorderStopPromise(webcamRecorder));
        }
        await Promise.all(pendingStops);

        const currentSession = session;
        if (!currentSession) {
            throw new Error("Recording session was not initialized.");
        }

        const screenBlob = new Blob(screenChunks, { type: currentMimeType });
        if (screenBlob.size === 0) {
            throw new Error("Screen recording has no data.");
        }

        await saveBlob(currentSession.sessionId, "screen.webm", screenBlob);

        if (webcamChunks.length > 0) {
            const webcamBlob = new Blob(webcamChunks, { type: currentMimeType });
            await saveBlob(currentSession.sessionId, "webcam.webm", webcamBlob);
        }

        completeText.textContent = `Saved recording session in: ${currentSession.sessionPath}`;
        completeCard.classList.remove("hidden");

        setStatus(reason ? `Recording stopped: ${reason} (${formatDuration(durationMs)})` : `Recording stopped and files saved. (${formatDuration(durationMs)})`);
    } catch (error) {
        setStatus(`Failed to finalize recording: ${toError(error)}`, true);
    } finally {
        isStopping = false;
        screenChunks = [];
        webcamChunks = [];
        stopStream(screenStream);
        screenStream = null;
        stopStream(webcamStream);
        webcamStream = null;
        screenPreview.srcObject = null;
        webcamPreview.srcObject = null;

        if (!isAppClosing) {
            await listSources();
        }
        setButtons();
    }
}

async function stopWebcamOnly() {
    if (!isRecording || isStopping || !webcamRecorder || webcamRecorder.state === "inactive") {
        return;
    }

    await recorderStopPromise(webcamRecorder);
    stopStream(webcamStream);
    webcamStream = null;
    webcamPreview.srcObject = null;
    setStatus("Webcam recording stopped. Screen recording continues.");
    setButtons();
}

function toError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

async function initializeSettings() {
    try {
        selectedSaveDir = await window.recorderApi.getVideosRoot();
    } catch {
        selectedSaveDir = null;
    }
    renderSaveDirLabel();
}

refreshBtn.addEventListener("click", () => {
    void listSources();
});

bitrateSelect.addEventListener("change", () => {
    const parsed = Number.parseInt(bitrateSelect.value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        selectedBitrate = parsed;
    }
});

chooseSaveDirBtn.addEventListener("click", () => {
    void window.recorderApi.pickSaveDirectory()
        .then((result) => {
            if (!result.directoryPath) {
                return;
            }
            selectedSaveDir = result.directoryPath;
            renderSaveDirLabel();
            setStatus(`Save location set to: ${selectedSaveDir}`);
        })
        .catch((error) => setStatus(`Unable to choose save folder: ${toError(error)}`, true));
});

webcamToggle.addEventListener("change", () => {
    void ensureWebcamPreview().catch((error) => {
        webcamToggle.checked = false;
        setStatus(`Webcam permission/device error: ${toError(error)}`, true);
    });
});

startBtn.addEventListener("click", () => {
    void startRecording();
});

stopBtn.addEventListener("click", () => {
    void stopRecording();
});

stopWebcamBtn.addEventListener("click", () => {
    void stopWebcamOnly();
});

openFolderBtn.addEventListener("click", () => {
    if (!session) {
        setStatus("No session available to open.", true);
        return;
    }
    void window.recorderApi.openSessionFolder(session.sessionId).catch((error) => {
        setStatus(`Unable to open folder: ${toError(error)}`, true);
    });
});

renameSessionBtn.addEventListener("click", () => {
    if (!session) {
        setStatus("No session to rename.", true);
        return;
    }

    const proposed = sessionNameInput.value.trim();
    if (!proposed) {
        setStatus("Enter a session name in the field first.", true);
        return;
    }

    void window.recorderApi.renameSession(session.sessionId, proposed)
        .then(() => setStatus("Session renamed."))
        .catch((error) => setStatus(`Unable to rename session: ${toError(error)}`, true));
});

window.addEventListener("beforeunload", () => {
    stopStream(screenStream);
    stopStream(webcamStream);
});

window.recorderApi.onBeforeClose(() => {
    isAppClosing = true;
    const finalizeClose = async () => {
        if (isRecording || isStarting || isStopping) {
            try {
                await stopRecording("App closing.");
            } catch {
                // no-op
            }
        }
        window.recorderApi.acknowledgeBeforeCloseHandled();
    };
    void finalizeClose();
});

setButtons();
void initializeSettings();
void listSources();
