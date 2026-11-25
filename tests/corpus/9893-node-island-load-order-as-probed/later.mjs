// Imported by the entry after its first two island imports and before its
// last one. It imports one of the entry's modules again.
import globalWriter from "state-kit/global-writer.js";
import processWriter from "state-kit/process-writer.js";
import processReader from "state-kit/process-reader.js";
import privateWriter from "state-kit/private-writer.js";
import privateReader from "state-kit/private-reader.js";
import bothA from "state-kit/both-a.js";
import bothB from "state-kit/both-b.js";

export const processMode = processReader.mode;
export const sharedCount = privateReader.count;
export const loaded = [globalWriter.wrote, processWriter.wrote, privateWriter.wrote, bothA.saw, bothB.saw];
