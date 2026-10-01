import { crashFile } from "./crash-file";
import { createCrashRecord, installCrashHandler } from "./crash-record";

export const crashRecord = createCrashRecord(crashFile);
installCrashHandler(globalThis.ErrorUtils, crashRecord);
