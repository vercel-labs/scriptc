// A program-owned CommonJS module loaded at run time (SPEC §5.6): the
// program compiles the package's core.js natively and registers into its
// singleton, then imports the package's own entry, whose registration must
// reach the SAME singleton. Node loads one instance of the module; an island
// that loaded a second would print a different size.
import { names, register, size } from "cjsregistry/lib/core.js";

async function main(): Promise<void> {
  register("native", "root");
  console.log(`before ${size()}`);
  const late = await import("cjsregistry/lib/index.js");
  console.log(`late ${String(late.loaded)}`);
  console.log(`after ${size()}`);
  console.log([...names()].join(","));
}

void main();
