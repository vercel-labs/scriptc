// Builtin class aliases exported from one module and used through named
// and namespace imports: construction, instanceof, typeof, .name and ===
// resolve to the builtin class in the importing module.
import { EventEmitter } from "node:events";
import { Emitter, Pass, Dict, Bag, Failure } from "./classes.ts";
import * as classes from "./classes.ts";

const e = new Emitter();
e.on("tick", (n: number) => console.log("tick", n));
e.emit("tick", 7);
console.log("emitter", e instanceof Emitter, e instanceof classes.Emitter, e instanceof EventEmitter);

const viaNs = new classes.Emitter();
console.log("namespace emitter", viaNs instanceof Emitter, Emitter === classes.Emitter);

const pass = new classes.Pass();
console.log("stream", pass instanceof Pass, pass instanceof classes.Emitter);

const dict = new Dict<string, number>([["k", 1]]);
const viaNsDict = new classes.Dict<string, string>();
viaNsDict.set("a", "b");
const bag = new classes.Bag<number>([1, 1, 2]);
console.log("collections", dict.get("k"), viaNsDict.get("a"), bag.size, dict instanceof classes.Dict, bag instanceof Bag);

try {
  throw new classes.Failure("wrong type");
} catch (err) {
  console.log("error", err instanceof Failure, err instanceof classes.Failure, (err as Error).message);
}

console.log("typeof", typeof Emitter, typeof classes.Pass, typeof Dict, typeof classes.Bag, typeof Failure);
console.log("name", Emitter.name, classes.Pass.name, Dict.name, classes.Bag.name, Failure.name);
console.log("identity", Dict === Map, classes.Bag === Set, Failure === TypeError, (Dict as unknown) === (Bag as unknown));
