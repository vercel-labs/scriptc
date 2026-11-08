// A constant table is one table under every name a module gives it: an
// import under another name, a re-export under another name, `export *`, a
// default export. What a name stands for is the checker's answer, so the
// decision whether a table takes the layout of the interface it is read
// through sees every use of it, whatever the use is spelled.
//
// `coast` and `delta` are only asked for members and handed to Route: each
// is built in Route's layout and is the object a Route reader holds. The
// list of `ridge` is read through the table's own type, under a name its
// module never wrote: that table keeps its own layout, and every read of it
// answers as before.

import { coast as sea, list, position, total } from "./routes.ts";
import { hill, marsh, delta as mouth } from "./relay.ts";
import express from "./express.ts";

list(sea);
list(marsh);

// One table under three names.
console.log(position(sea), position(express), sea === express);
console.log(position(marsh), position(mouth), marsh === mouth);
console.log(sea.code, express.fare, marsh.code, mouth.fare);

// A binding declared from a table is one more name of it.
const again = marsh;
const { code, fare } = sea;
console.log(position(again), again.code, code, fare);

function nearest(): number {
  const local = express;
  return position(local) + local.fare;
}
console.log(nearest());

// A list read through the table's own type.
console.log(hill.stops[1], hill.stops.length, hill.code);
for (const stop of hill.stops) console.log(stop);
console.log(total(hill), total(sea), total(mouth));
