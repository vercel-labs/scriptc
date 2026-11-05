// A class extending EventEmitter<EventMap>: the type argument is the
// listener MAP — a pure typing aid with no runtime layout of its own, so
// the emitted class adopts the same emitter base (Node erases it too).
// on/emit dispatch keeps Node's order, and the subclass's own members
// stay alongside the inherited ones.
import { EventEmitter } from "node:events";

interface BufferEvents {
  data: [chunk: string];
  end: [];
}

class StdinBuffer extends EventEmitter<BufferEvents> {
  private chunks: string[] = [];
  push(chunk: string): void {
    this.chunks.push(chunk);
    this.emit("data", chunk);
  }
  finish(): void {
    console.log("joined", this.chunks.join(""));
    this.emit("end");
  }
}

const buffer = new StdinBuffer();
buffer.on("data", (chunk) => console.log("data", chunk));
buffer.on("end", () => console.log("end"));
buffer.push("a");
buffer.push("b");
buffer.finish();
console.log("listeners", buffer.listenerCount("data"));
