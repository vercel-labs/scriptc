// The worker's module graph reaches a Node island: refuse it here, on the
// worker thread that cannot initialize Node.
import { requireModule } from "@scriptc/node";
import { parentPort } from "node:worker_threads";

interface Lib {
  answer(): number;
}
const lib = requireModule<Lib>("./lib.cjs");
parentPort?.postMessage(lib.answer());
