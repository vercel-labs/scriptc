// @requires-libnode
/// <reference path="./refs/labels.d.ts" />
// A tsconfig with `typeRoots` and no `types`: tsc loads every package
// directory under the type root, whether or not anything names it (the
// declarations of an untyped package, and global types), beside the
// declaration files `include` names (an ambient module, a global
// augmentation) and one a path reference names. Two island rounds.
import { scale } from "pantry-units";
import { words } from "word-kit";
import * as oven from "oven-dial";

const tripled = scale([4, 0.5], 3);
const tiles: TileList = [{ width: 2, height: 3 }];
const first: Tile = tiles[0];
const label: TileLabel = `${first.width}x${first.height}`;
// A package directory whose package.json sets `typings` to null is not
// loaded: the interface it would extend has no member.
const marks: keyof TileMarks extends never ? "none" : "some" = "none";
console.log(tripled.join("+"), words("two words").length, label, marks);
console.log(oven.gasMark(205), oven.hottest);
