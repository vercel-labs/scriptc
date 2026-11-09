// The owner of a stream, read by a listener on that stream, is a cycle:
// owner -> stream -> listener -> owner. The streams are a Writable, a
// Readable, a PassThrough and a program subclass of Writable; the owners
// hold them in a record member, a nullable member, a class member and an
// array. Each pair is dropped after the stream ended with its listeners in
// place, without ever being used, or with the listeners removed first.
// Node collects every pair. The reference-count audit of the sanitized
// lane fails when the cycle collector does not trace an owner, whatever
// the program prints.
import { PassThrough, Readable, Writable } from "node:stream";

class Ledger extends Writable {
  lines = 0;
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.lines += chunk.length > 0 ? 1 : 0;
    callback();
  }
}

type Parcel = { tag: string; label: Writable; weight: number };
type Crate = { tag: string; manifest: Readable | null; weight: number };
class Pallet {
  belt: PassThrough;
  weight = 0;
  constructor(belt: PassThrough) {
    this.belt = belt;
  }
}
type Depot = { ledgers: Ledger[]; weight: number };

let written = 0;
let events = 0;
let weight = 0;

function parcel(mode: string, round: number): void {
  const label = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      written += chunk.length;
      callback();
    },
  });
  const owner: Parcel = { tag: "p" + round, label, weight: round };
  label.on("finish", () => {
    events++;
    weight += owner.weight + (owner.label.writableFinished ? 1 : 0);
  });
  label.on("drain", () => {
    owner.weight++;
  });
  label.on("error", () => {
    owner.weight = -1;
  });
  if (mode === "idle") return;
  if (mode === "removed") label.removeAllListeners();
  label.write("to " + owner.tag);
  label.end();
}

function crate(mode: string, round: number): void {
  const manifest = new Readable({ read() {} });
  const owner: Crate = { tag: "c" + round, manifest: null, weight: round };
  owner.manifest = manifest;
  manifest.on("end", () => {
    events++;
    weight += owner.manifest === null ? 0 : owner.weight;
  });
  manifest.on("data", (chunk: Buffer) => {
    owner.weight += chunk.length;
  });
  if (mode === "idle") return;
  if (mode === "removed") {
    manifest.removeAllListeners();
    manifest.resume();
  }
  manifest.push("item " + round);
  manifest.push(null);
}

function pallet(mode: string, round: number): void {
  const belt = new PassThrough();
  const owner = new Pallet(belt);
  belt.on("finish", () => {
    events++;
    weight += owner.weight + (owner.belt.writableEnded ? 2 : 0);
  });
  belt.on("data", (chunk: Buffer) => {
    owner.weight += chunk.length;
  });
  if (mode === "idle") return;
  if (mode === "removed") {
    belt.removeAllListeners();
    belt.resume();
  }
  belt.end("box " + round);
}

function depot(mode: string, round: number): void {
  const owner: Depot = { ledgers: [new Ledger(), new Ledger()], weight: round };
  for (const ledger of owner.ledgers) {
    ledger.on("finish", () => {
      events++;
      weight += owner.ledgers.length + ledger.lines;
    });
  }
  if (mode === "idle") return;
  for (const ledger of owner.ledgers) {
    if (mode === "removed") ledger.removeAllListeners();
    ledger.write("entry " + round);
    ledger.end();
  }
}

function run(modes: string[], at: number): void {
  if (at === modes.length) return;
  const mode = modes[at]!;
  const eventsBefore = events;
  const weightBefore = weight;
  const writtenBefore = written;
  for (let round = 0; round < 30; round++) {
    parcel(mode, round);
    crate(mode, round);
    pallet(mode, round);
    depot(mode, round);
  }
  // Every stream of this mode has settled by the time a timer runs.
  setTimeout(() => {
    console.log(mode, "events", events - eventsBefore, "weight", weight - weightBefore, "bytes", written - writtenBefore);
    run(modes, at + 1);
  }, 5);
}

run(["ended", "idle", "removed"], 0);
