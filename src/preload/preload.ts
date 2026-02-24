import { contextBridge, ipcRenderer } from "electron";

type CaptureSource = {
    id: string;
    name: string;
    thumbnailDataUrl: string;
    displayId: string;
};

type SessionCreateResult = {
    sessionId: string;
    sessionPath: string;
};

const api = {
    getVideosRoot: () => ipcRenderer.invoke("app:get-videos-root") as Promise<string>,
    setVideosRoot: (directoryPath: string) => ipcRenderer.invoke("app:set-videos-root", { directoryPath }) as Promise<{ directoryPath: string }>,
    pickSaveDirectory: () => ipcRenderer.invoke("app:pick-save-directory") as Promise<{ directoryPath: string | null }>,
    listSources: () => ipcRenderer.invoke("capture:list-sources") as Promise<CaptureSource[]>,
    createSession: (name?: string) => ipcRenderer.invoke("session:create", { name }) as Promise<SessionCreateResult>,
    renameSession: (sessionId: string, name: string) => ipcRenderer.invoke("session:rename", { sessionId, name }) as Promise<{ success: true }>,
    saveRecordingFile: (sessionId: string, fileName: "screen.webm" | "webcam.webm", data: ArrayBuffer) =>
        ipcRenderer.invoke("recording:save-file", { sessionId, fileName, data }) as Promise<{ success: true; path: string }>,
    openSessionFolder: (sessionId: string) => ipcRenderer.invoke("session:open-folder", { sessionId }) as Promise<{ success: true }>,
    onBeforeClose: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("app:before-close", handler);
        return () => ipcRenderer.removeListener("app:before-close", handler);
    },
    acknowledgeBeforeCloseHandled: () => ipcRenderer.send("app:before-close-ack"),
};

contextBridge.exposeInMainWorld("recorderApi", api);
