// @requires-libnode
// Native code steps island iterators by hand (next/return through the
// handle) and loops over an island sync generator with for-of and a break.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function main() {
  const it = lib.gen(5);
  const show = (r) => log(`${r.value} ${r.done}`);
  show(await it.next());
  show(await it.return("early"));
  show(await it.next());
  const s = lib.syncGen(3);
  show(s.next());
  show(s.return(9));
  for (const v of lib.syncGen(4)) {
    log(`native got ${v}`);
    if (v === 20) break;
  }
  log("end");
}

main();
