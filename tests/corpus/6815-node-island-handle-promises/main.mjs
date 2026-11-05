// @requires-libnode
// Island promises as program promises (scope-B NI-4): awaiting one settles
// through a V8 reaction on the one hosted loop; rejections keep their
// error; the same Node promise is the same program promise.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

async function main() {
  console.log("later", await lib.later("value", 5));
  try {
    await lib.fails("nope");
  } catch (e) {
    console.log("rejected", e instanceof RangeError, e.message);
  }
  const o = await lib.object();
  console.log("object", o.answer, typeof o);
  const p = lib.keep();
  console.log("promise identity", lib.isKept(p), await p);
  const all = await Promise.all([lib.later(1, 3), lib.later(2, 1)]);
  console.log("all", all.join(","));
}

main().then(() => console.log("done"));
