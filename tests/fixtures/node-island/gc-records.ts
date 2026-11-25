// Records whose fields cannot form a cycle are collected with their requests
// (node-island-gc.test.ts): each iteration hands a new record to the island
// and drops it. Such a record has no cycle header, so the walk before a
// major GC never enters it; it still counts the reference its capsule holds.
// Ten records stay with the program and four with the island whatever the
// count, and what the island remembered about the program's ten by their
// identity is still there at the end.
// Usage: gc-records <n>
import { requireModule } from "@scriptc/node";

interface Request {
  attempt: number;
  label: string;
}

const lib = requireModule("./gc-records.cjs");
const n = Number(process.argv[2] ?? "1000");
const kept: Request[] = [];
for (let i = 0; i < n; i++) {
  const request: Request = { attempt: i, label: "r" + i };
  lib.handle(request);
  if (i < 10) {
    kept.push(request);
    lib.note(request, i);
  } else if (i < 14) {
    lib.hold(request);
  }
}
// The program's ten are still the objects the island noted, and the island
// reads what the program writes to them.
for (const request of kept) request.attempt += 1000;
console.log(lib.counts(), lib.noted(kept));
