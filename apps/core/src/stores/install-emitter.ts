import { EventEmitter } from "node:events";

export interface InstallProgressEvent {
  stage: "queued" | "pulling" | "creating" | "starting" | "running" | "error";
  message: string;
}

class InstallProgressEmitter extends EventEmitter {}

export const installProgress = new InstallProgressEmitter();
installProgress.setMaxListeners(50);

export function emitProgress(appId: string, event: InstallProgressEvent) {
  installProgress.emit(appId, event);
}
