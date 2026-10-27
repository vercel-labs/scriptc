// Classes that the program reaches only through `import type`: no module
// loads emitted.ts, so no instance of its classes exists, and their types
// describe the object shapes the program does hold, as an interface would.
// Fields of those types hold undefined, object literals, and arrays of them.
import { Holder } from "./holder.ts";
import type { Emitted } from "./emitted.ts";

const holder = new Holder();
console.log(holder.items === undefined, holder.sealed === undefined);
const result: Emitted = { count: 2, files: ["a.js", "b.js"], summary: () => "two files" };
holder.record(result);
holder.record({ count: 0, files: [], summary: () => "none" });
console.log(holder.items?.count, holder.items?.summary(), holder.history.length);
console.log(holder.history[0] === result, holder.history[0]!.files.join(","));
console.log(JSON.stringify(holder.history.map((entry) => entry.count)));
holder.totals.skipped++;
console.log(holder.totals, JSON.stringify(holder.totals));
