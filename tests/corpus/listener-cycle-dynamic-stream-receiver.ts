// A generic method of an object literal takes a stream typed by its type
// parameter, so inside the method the stream is a dynamic value and its
// listeners are registered as dynamic function values. Each listener reads
// the record that owns the stream: owner -> stream -> listener -> owner.
// The events are the ones a stream emits by itself (drain, finish, error,
// close on the writable side; data, end on the readable side) and one the
// program emits. The pairs are dropped after the stream ended, unused, or
// with the listeners removed. Node collects every pair; the reference-count
// audit of the sanitized lane fails when the cycle collector cannot see
// through a listener registered this way, whatever the program prints.
import { PassThrough, Readable, Writable } from "node:stream";

type Track = { title: string; tape: Writable; takes: number; trouble: string };
type Sample = { title: string; source: Readable; bytes: number };
type Bus = { title: string; line: PassThrough; level: number };

type Desk = {
  arm<T extends Writable>(tape: T, track: Track): T;
  cue<T extends Readable>(source: T, sample: Sample): T;
  patch<T extends PassThrough>(line: T, bus: Bus): T;
};

let recorded = 0;
let events = 0;
let levels = 0;

function desk(): Desk {
  let armed = 0;
  return {
    arm<T extends Writable>(tape: T, track: Track): T {
      armed++;
      tape.on("drain", () => {
        track.takes++;
      });
      tape.on("error", () => {
        track.trouble = "tape error";
      });
      tape.on("close", () => {
        track.trouble = track.trouble === "" ? "closed" : track.trouble;
        events++;
      });
      tape.once("finish", () => {
        levels += track.takes + track.title.length + armed * 0;
        events++;
      });
      tape.on("rewind", () => {
        track.takes += 10;
        events++;
      });
      return tape;
    },
    cue<T extends Readable>(source: T, sample: Sample): T {
      source.on("data", (chunk: Buffer) => {
        sample.bytes += chunk.length;
      });
      source.on("end", () => {
        levels += sample.bytes;
        events++;
      });
      return source;
    },
    patch<T extends PassThrough>(line: T, bus: Bus): T {
      line.on("data", (chunk: Buffer) => {
        bus.level += chunk.length;
      });
      line.on("finish", () => {
        levels += bus.level + (bus.line.writableEnded ? 1 : 0);
        events++;
      });
      return line;
    },
  };
}

function track(mode: string, round: number): void {
  const tape = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      recorded += chunk.length;
      callback();
    },
  });
  const owner: Track = { title: "t" + round, tape, takes: 0, trouble: "" };
  desk().arm(tape, owner);
  if (mode === "idle") return;
  if (mode === "removed") tape.removeAllListeners();
  tape.emit("rewind");
  tape.write("take " + round);
  tape.end();
}

function sample(mode: string, round: number): void {
  const source = new Readable({ read() {} });
  const owner: Sample = { title: "s" + round, source, bytes: 0 };
  desk().cue(source, owner);
  if (mode === "idle") return;
  if (mode === "removed") {
    source.removeAllListeners();
    source.resume();
  }
  source.push("loop " + round);
  source.push(null);
}

function bus(mode: string, round: number): void {
  const line = new PassThrough();
  const owner: Bus = { title: "b" + round, line, level: 0 };
  desk().patch(line, owner);
  if (mode === "idle") return;
  if (mode === "removed") {
    line.removeAllListeners();
    line.resume();
  }
  line.end("mix " + round);
}

function run(modes: string[], at: number): void {
  if (at === modes.length) return;
  const mode = modes[at]!;
  const eventsBefore = events;
  const levelsBefore = levels;
  const recordedBefore = recorded;
  for (let round = 0; round < 30; round++) {
    track(mode, round);
    sample(mode, round);
    bus(mode, round);
  }
  // Every stream of this mode has settled by the time a timer runs.
  setTimeout(() => {
    console.log(mode, "events", events - eventsBefore, "levels", levels - levelsBefore, "bytes", recorded - recordedBefore);
    run(modes, at + 1);
  }, 5);
}

run(["ended", "idle", "removed"], 0);
