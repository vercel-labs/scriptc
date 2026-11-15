// Exported enums used as values from other modules: by name, renamed, as a
// default export, through a re-export and through a namespace import. Each
// is the declaring module's one object.
import DefaultInner, { Dir, Tone, Renamed, Fixed, MembersOnly, dirNames } from "./lib.ts";
import * as ns from "./lib.ts";
import { Direction, lib } from "./reexport.ts";

console.log(JSON.stringify(Object.entries(Dir)), Object.values(Tone).join(","));
console.log(Object.keys(Renamed).join(","), Object.keys(DefaultInner).join(","));
console.log(Dir === Direction, Dir === ns.Dir, lib.Tone === Tone, DefaultInner === Renamed);
console.log(Object.keys(ns.Dir).join(","), ns.Dir[1], Direction[2], lib.Dir[Dir.Up]);
console.log(Fixed.A, MembersOnly.X, MembersOnly[2], dirNames().join(","));
const which: number = Number(process.argv[2] ?? "2");
console.log(ns.Dir[which], Direction[which + 1], Object.entries(lib.Tone).length);
