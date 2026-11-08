// Program errors that cross into a Node island and are dropped
// (node-island-gc.test.ts). Every iteration sends four: one thrown from a
// callback through an island call and caught by the program, one the island
// catches, one passed as an argument, and one as another error's cause.
// Each has one V8 Error, held through the export table, and a view the
// runtime's error-view cache holds; both must go when the program and the
// island drop the error. Usage: gc-native-errors <n>
import { requireModule } from "@scriptc/node";

const lib = requireModule("./gc-native-errors.cjs");
const n = Number(process.argv[2] ?? "1000");

class AppError extends Error {
  constructor(message, index) {
    super(message);
    this.name = "AppError";
    this.index = index;
    this.payload = "x".repeat(256);
  }
}

let checks = 0;
for (let i = 0; i < n; i++) {
  const e = new AppError("native " + i, i);
  try {
    lib.run(() => {
      throw e;
    });
  } catch (x) {
    if (x === e) checks++;
  }
  checks += lib.swallow(() => {
    throw new AppError("swallowed " + i, i);
  }, i);
  if (lib.read(new Error("plain " + i)) > 0) checks++;
  if (lib.causeIndex(new Error("outer " + i, { cause: e })) === i) checks++;
}
console.log("iterations", n, "checks", checks);
console.error(`peak rss ${lib.maxRss()} KiB`);
