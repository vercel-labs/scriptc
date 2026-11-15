// @requires-libnode
// Under node10 resolution tsc finds a package's files by their path and
// never reads its `exports` map. This project declares two mapped subpaths
// as the files behind them (shims/subpaths.d.ts): one of a package that
// compiles natively, and one of a CommonJS package whose namespace import
// makes the build decide a Node island. It also names a type in a file no
// map lists, and imports a mapped subpath whose declarations lie where only
// a lookup by path comes across them. What runs is still resolved by Node,
// through the map.
import { blend, titles, type Blend } from "spice-rack/blends";
import type { Heat } from "spice-rack/lib/heat.mjs";
import * as pot from "stock-pot/timers";
import { rise } from "bread-proof/rise";

const heat: Heat = titles.length > 2 ? "warm" : "mild";
const picked: Blend = blend(titles[1]);
console.log(titles.length, picked.title, picked.parts, heat);
console.log(pot.stages.join(","), pot.simmer(pot.stages.length * 10));
console.log(rise(1.5));
