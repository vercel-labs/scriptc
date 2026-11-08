// A createRequire loader read as a VALUE in TypeScript: kept in a record
// (shorthand and named members), passed to a function, held in a typed
// function slot and aliased. The value is one run-time require function
// (every read is the same value); a request that does not resolve throws
// Node's MODULE_NOT_FOUND where it is called. A program that only holds the
// loader never calls into it.
import { createRequire } from "node:module";

const narrate = createRequire(import.meta.url);

interface Tour {
  rooms: string[];
  load: (id: string) => unknown;
  quiet?: boolean;
}

function failure(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return String(err.code) + " / " + String(err.message).split("\n")[0];
}

function walk(tour: Tour): number {
  let missing = 0;
  for (const room of tour.rooms) {
    try {
      tour.load("./narration-" + room + ".js");
    } catch (e) {
      missing++;
      if (!tour.quiet) console.log(room, failure(e));
    }
  }
  return missing;
}

function plan(tour: Tour): () => number {
  return () => tour.rooms.length;
}

const guide = { room: "crypt", narrate };
const again = narrate;
const held: unknown = narrate;
console.log(typeof guide.narrate, typeof again, typeof held, again === narrate, guide.narrate === again);

console.log(walk({ rooms: ["nave", "apse"], load: narrate }));
console.log(walk({ rooms: ["tower"], load: guide.narrate, quiet: true }));
console.log(plan({ rooms: ["nave", "apse", "tower"], load: narrate })());

try {
  guide.narrate("no-such-narrator-" + guide.room);
  console.log("loaded");
} catch (e) {
  console.log(failure(e));
}
