// Bindings of Node island packages reach this module through native
// modules that import them and export them again (relay.ts, onward.ts):
// under the same name, renamed, as the default export, by a star export and
// through a second hop. Each binds the island's own export: a function, a
// class, a constant, and a live binding of an ES module.
import viaDefault, { Ledger, SCALE, callCount, describeLevel, level, raise, tally, tallyLater, twice } from "./relay.ts";
import { count, tally as starred } from "./onward.ts";
import * as relay from "./relay.ts";

async function main(): Promise<void> {
  const crates = ["ash", "birch", "cedar"];
  console.log(tally(crates), await tallyLater(crates, "x"), await tallyLater([]), twice(["oak"]));
  console.log(viaDefault(["a"]), count(["a", "b"]), starred([]), relay.tally(crates), callCount());
  const held = tally;
  console.log([["ash"], ["birch", "cedar"]].map((list) => tally(list)).join(","), held(["x"]), typeof tally);
  const ledger = new Ledger("north");
  ledger.add(2).add(5);
  console.log(ledger.name, ledger.total(), ledger instanceof Ledger, SCALE + 1);
  console.log(level, raise(), level, describeLevel(), relay.level);
}

main();
