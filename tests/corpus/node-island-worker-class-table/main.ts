// @requires-libnode
// The first threads to hand an instance of a class to the island are
// workers, and they have ended when the main thread hands one over. An
// instance's prototype methods reach the island through a table built once
// per class by the thread that crosses the first instance. That table
// belongs to the island's thread, which reads it without a lock and calls
// what it holds, so a worker's crossing must leave none behind. (The
// worker's own instance does not cross: a native object passed by reference
// from a worker is refused by name, which this program does not print, so
// that its output is Node's.)
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { count, label, norm } from "shape-pkg";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return Math.hypot(this.x, this.y);
  }
  label(): string {
    return `(${this.x},${this.y})`;
  }
}

if (isMainThread) {
  let ended = 0;
  const after = (): void => {
    if (++ended < count()) return;
    console.log("main", norm(new Point(3, 4)), label(new Point(5, 6)));
    let total = 0;
    for (let i = 0; i < 2000; i++) total += norm(new Point(i, 0));
    console.log("main total", total);
  };
  for (let w = 0; w < count(); w++) {
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", (message: string) => console.log(message));
    worker.on("exit", after);
  }
} else {
  let tried = 0;
  for (let i = 0; i < 50; i++) {
    try {
      norm(new Point(6 + i, 8));
    } catch {
      // The refusal of a worker's native object, by name.
    }
    tried++;
  }
  parentPort!.postMessage(`worker tried ${tried}`);
}
