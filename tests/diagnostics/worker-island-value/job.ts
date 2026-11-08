// The worker's entry: only worker threads run this module.
import { parentPort } from "node:worker_threads";
import { each, settled, shout, sum, tagged } from "crossing-pkg";

const bytes = new Uint8Array(4);
const later: Promise<number> = Promise.resolve(1);
const tag: symbol = Symbol("tag");
// What crosses as a copy is fine from a worker.
parentPort!.postMessage(shout("text"));
parentPort!.postMessage(sum(bytes));
parentPort!.postMessage(each((n: number) => n + 1));
parentPort!.postMessage(settled(later));
parentPort!.postMessage(tagged(tag));
