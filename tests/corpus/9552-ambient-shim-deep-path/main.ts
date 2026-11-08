// @requires-libnode
// A project that compiles under `moduleResolution: node` reads a package's
// files by path, never through its `exports` map. It types a subpath export
// with an ambient module that re-exports the file the subpath names
// (`types/*.d.ts`), for a package that compiles natively and for one that
// runs in a Node island; it imports a type from a file the map does not
// list; and it imports a subpath whose declarations sit where a lookup by
// path finds them. Node resolves what runs, with the map.
import { type CliCommand, commands, run } from "shapes-kit/cli";
import type { Palette } from "shapes-kit/dist/palette.mjs";
import * as lineCli from "line-kit/cli";
import { rule } from "rule-kit/cli";

const first: CliCommand = commands[0];
const palette: Palette = { ink: "black", paper: "white" };
console.log(commands.length, run(first.name));
console.log(palette.ink, palette.paper);
console.log(lineCli.widths.length, lineCli.rule(lineCli.widths[0]));
console.log(rule(4));
