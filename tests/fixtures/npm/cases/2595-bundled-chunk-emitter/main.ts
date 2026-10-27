// A bundled CommonJS chunk whose top-level var statement mixes
// require("events"), require("util"), a sibling chunk's require and a class
// expression extending the events binding, followed by an untyped alias of
// the events module. The require bindings own no storage: the semaphore's
// constructor builds its release channel through them, its queue through
// the sibling chunk's constructor function, and both channels emit.
import { aliased, limited } from "gtchunkee";

console.log(aliased());
console.log(await limited("two slots", 4, 2));
console.log(await limited("one slot", 3, 1));
