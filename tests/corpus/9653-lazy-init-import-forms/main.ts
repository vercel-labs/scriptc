// Modules that only compute, loaded in every way a program loads a module:
// by an import declaration, by import(), by both, behind an import that
// throws, in an order decided at run time, and in an import cycle. They
// draw from counters while they load, so the order they ran in shows.
import { history, id } from "./ids.ts";
import { SQUARES, DRAWN, BOX, square } from "./squares.ts";

async function run(): Promise<void> {
  console.log("main starts");
  // Two modules that only compute, loaded in an order the program decides
  // here and read afterwards: the one loaded first drew first.
  const order = process.argv.length > 0 ? ["second", "first"] : ["first", "second"];
  for (const name of order) {
    if (name === "first") await import("./first.ts");
    else await import("./second.ts");
  }
  const first = await import("./first.ts");
  const second = await import("./second.ts");
  console.log("ordered", first.FIRST.join("/"), second.SECOND.join("/"));
  // A module the program imports statically, again by import(): the same
  // bindings and the same objects.
  const again = await import("./squares.ts");
  console.log(
    "squares",
    again.SQUARES === SQUARES,
    again.BOX === BOX,
    again.BOX.rows === SQUARES,
    again.DRAWN === DRAWN,
    DRAWN,
    square(7),
    again.square(8),
  );
  // A module that prints while it loads does so at its import(), once, and
  // reads a module that only computes while it does.
  const loud = await import("./loud.ts");
  const loudAgain = await import("./loud.ts");
  console.log("loud", loud.LOUD, loud.SEEN, loudAgain === loud);
  console.log("main draws", id("main"));
  // A module that only computes behind an import that throws: both loads
  // fail, with the same error, and the failing module ran once.
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const mod = await import("./needs-broken.ts");
      console.log("loaded", mod.CUBES.length, mod.missing());
    } catch (error) {
      failures.push(error);
      console.log("failed", error instanceof RangeError, (error as Error).message);
    }
  }
  try {
    await import("./broken.ts");
    console.log("broken loaded");
  } catch (error) {
    failures.push(error);
  }
  console.log(
    "same error",
    failures.length,
    failures[0] === failures[1],
    failures[1] === failures[2],
  );
  // Inputs read at load are read when import() loads the module.
  process.env["LAZY_INIT_FORMS"] = "set-before-load";
  const before = Date.now();
  const settings = await import("./settings.ts");
  console.log("settings", settings.MODE, settings.PARTS.join("+"), settings.AT >= before);
  process.env["LAZY_INIT_FORMS"] = "set-after-load";
  console.log("settings", (await import("./settings.ts")).MODE);
  // An import cycle, entered from either end.
  const ringB = await import("./ring-b.ts");
  const ringA = await import("./ring-a.ts");
  console.log("ring", ringA.both(), ringB.describeB(), ringA.NAMES_A.length, ringB.NAMES_B.length);
  // Loaded and never read.
  await import("./unused.ts");
  console.log("history", history());
  // A rejected import() nothing awaited in a try: the same error again.
  import("./needs-broken.ts").then(
    () => console.log("loaded late"),
    (error: unknown) => console.log("late", error === failures[0]),
  );
}
await run();
