// Readable flow control and state: pause()/resume() over readableFlowing and
// isPaused(), the 'pause'/'resume' events, and the readable, closed and
// high-water-mark state across a stream's life.
import { Readable } from "node:stream";

const idle = Readable.from(["a", "b"]);
console.log("idle", idle.readableFlowing, idle.isPaused(), idle.readable, idle.readableObjectMode, idle.readableHighWaterMark, idle.closed);
idle.pause();
console.log("paused", idle.readableFlowing, idle.isPaused());
idle.resume();
console.log("resumed", idle.readableFlowing, idle.isPaused());

// A flowing stream stops at pause() and starts again at resume(), and each
// step reaches its listener.
const events = [];
const flowing = Readable.from(["c", "d"]);
flowing.on("pause", () => events.push("pause"));
flowing.on("resume", () => events.push("resume"));
const chunks = [];
flowing.on("data", (chunk) => chunks.push(String(chunk)));
flowing.pause();
flowing.resume();
const closed = new Promise((resolve) => flowing.on("close", resolve));
await new Promise((resolve) => flowing.on("end", resolve));
await closed;
console.log("flow", events.join(","), chunks.join(","), flowing.readableFlowing, flowing.isPaused(), flowing.readable, flowing.closed);

// A paused stream hands its listener nothing until it resumes.
const held = [];
const paused = Readable.from(["e", "f"]);
paused.on("data", (chunk) => held.push(String(chunk)));
paused.pause();
await new Promise((resolve) => setImmediate(resolve));
console.log("held", held.length, paused.isPaused());
paused.resume();
await new Promise((resolve) => paused.on("end", resolve));
console.log("released", held.join(","), paused.readable);

// The 'readable' event drives the read() form: every chunk is read inside the
// listener and the stream is no longer readable at its end.
const reads = [];
const readableEvent = Readable.from(["g", "h"]);
await new Promise((resolve) => {
  readableEvent.on("readable", () => {
    let chunk;
    while ((chunk = readableEvent.read()) !== null) reads.push(String(chunk));
  });
  readableEvent.on("end", resolve);
});
console.log("readable-event", reads.join(","), readableEvent.readable);

// resume() after the end changes nothing.
const done = Readable.from(["i"]);
const ended = new Promise((resolve) => done.on("end", resolve));
done.resume();
await ended;
console.log("ended", done.readableFlowing, done.readable);
done.resume();
console.log("after-end", done.readableFlowing, done.isPaused(), done.readable);
