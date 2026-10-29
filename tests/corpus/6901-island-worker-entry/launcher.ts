/// <reference path="./globals.d.ts" />
// Runs in a Node island: it extends a host class only Node has, so the
// native lowering refuses the module and the build runs it in Node (the
// 6900 mechanism). The Worker it starts is Node's own: the build ships
// worker.ts and what it imports beside this module, and the URL this module
// builds at run time names the same file in the shipped tree.
import { Worker } from "node:worker_threads";

export class Socket extends WebSocket {
  static tag = "socket";
}

// The program reads the class, so the refusable base is live code: the
// build islanded this module rather than inventing a native base.
export function socketTag(): string {
  return `${Socket.tag}:${Object.getPrototypeOf(Socket) === WebSocket}`;
}

export async function roundTrip(value: number): Promise<string> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url));
  const reply = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  const firstMessage = reply();
  worker.postMessage(value);
  const first = await firstMessage;
  const secondMessage = reply();
  worker.postMessage(value + 1);
  const second = await secondMessage;
  await worker.terminate();
  return `${first} ${second}`;
}
