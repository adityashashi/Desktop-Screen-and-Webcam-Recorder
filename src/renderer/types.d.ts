export { };

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

declare global {
    interface Window {
        recorderApi: {
            getVideosRoot: () => Promise<string>;
            setVideosRoot: (directoryPath: string) => Promise<{ directoryPath: string }>;
            pickSaveDirectory: () => Promise<{ directoryPath: string | null }>;
            listSources: () => Promise<CaptureSource[]>;
            createSession: (name?: string) => Promise<SessionCreateResult>;
            renameSession: (sessionId: string, name: string) => Promise<{ success: true }>;
            saveRecordingFile: (sessionId: string, fileName: "screen.webm" | "webcam.webm", data: ArrayBuffer) => Promise<{ success: true; path: string }>;
            openSessionFolder: (sessionId: string) => Promise<{ success: true }>;
            onBeforeClose: (callback: () => void) => () => void;
            acknowledgeBeforeCloseHandled: () => void;
        };
    }
}
