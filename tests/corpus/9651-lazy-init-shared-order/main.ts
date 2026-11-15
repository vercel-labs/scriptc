// The order modules run in is observable through shared state, even when
// none of them prints: every module here draws numbers from one counter.
// table.ts and late.ts only compute; loud.ts prints while it loads; the
// program then reads them in an order that differs from the import order.
import { history, id } from "./ids.ts";
import { ROWS, BY_NAME, find } from "./table.ts";
import { LOUD } from "./loud.ts";
import { LATE, SEEN, FIRST } from "./late.ts";
import { mode, changes, setMode } from "./state.ts";
import { both, NAMES_A } from "./ring-a.ts";
import { viaA } from "./ring-b.ts";
import "./unused.ts";

function run(): void {
  console.log("main starts");
  // Read the later module first: its numbers are still the later ones.
  console.log("late", LATE.join(), SEEN, FIRST.name);
  console.log("rows", ROWS.map((row) => row.id + ":" + row.name).join(" "));
  console.log("main draws", id("main"));
  console.log("history", history());
  console.log("loud", LOUD.join());
  // Identity: the same objects through every path.
  console.log(FIRST === ROWS[0], find("beta") === ROWS[1], BY_NAME.get("gamma") === ROWS[2], BY_NAME.size);
  // A table changed by the program is the table the other readers see.
  ROWS[0]!.tags.push("changed");
  ROWS.push({ id: id("main"), name: "delta", tags: [] });
  console.log(FIRST.tags.join(), find("alpha")!.tags.length, ROWS.length, find("delta"));
  // A binding the module reassigns.
  console.log(mode, changes);
  setMode("warm");
  console.log(mode, changes);
  // Modules that import each other.
  console.log(both(), viaA(), NAMES_A.length);
  // Reads from a loop, a closure, a method and a timer.
  let total = 0;
  for (let i = 0; i < 1000; i++) total += ROWS[i % ROWS.length]!.id;
  const reader = (): number => LATE[0]! + LATE[1]!;
  class Report {
    rows(): number {
      return ROWS.length + LATE.length;
    }
  }
  console.log(total, reader(), new Report().rows());
  setTimeout(() => {
    console.log("timer", ROWS.length, history());
  }, 1);
}
// Always true, and not known to the compiler: nothing above is used for
// certain when the program starts.
if (process.argv.length > 0) run();
else console.log("not reached");
