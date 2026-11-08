// A createRequire loader as a shorthand member of an object literal in
// JavaScript is the loader value the long form `{ narrate: narrate }`
// reads: the same function, and a request that does not resolve throws
// Node's MODULE_NOT_FOUND where it is called.
import { createRequire } from "node:module";

const narrate = createRequire(import.meta.url);
const guide = { room: "crypt", narrate };
const long = { room: "vault", narrate: narrate };

console.log(typeof guide.narrate, guide.narrate === narrate, guide.narrate === long.narrate);
for (const stop of [guide, long]) {
  try {
    stop.narrate("./narration-" + stop.room + ".js");
    console.log("loaded");
  } catch (e) {
    console.log(stop.room, String(e.code), String(e.message).split("\n")[0]);
  }
}
