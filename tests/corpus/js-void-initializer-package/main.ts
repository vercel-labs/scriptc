// An untyped CommonJS package in a transpiler's spelling: a variable declared
// with `void 0`, assigned inside a try block and handed on. The package's
// text is rewritten for native compilation, and the declarator holds what
// the write stored in that text too.
import run from "late-value";
import settle from "late-value/settle.js";

async function main(): Promise<void> {
  console.log(String(await run((n) => "value " + n)));
  console.log(String(await run(async (n) => n + 41)));
  try {
    await run(() => {
      throw new Error("thrown");
    });
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  console.log(String(settle.all([() => 1, () => "two", () => [3]])));
  console.log(String(settle.all([])));
  console.log(
    String(
      settle.all([
        () => 1,
        () => {
          throw new Error("second");
        },
      ]),
    ),
  );
  console.log(String(settle.count()));
}

main();
