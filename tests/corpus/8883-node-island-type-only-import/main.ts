// @requires-libnode
// A patched-member reader joins the Node island set (pi's provider-env.ts
// shape), and a type-only clause names the one module holding a computed
// import() (pi's env-api-keys.ts:8 shape). Node's type stripping erases that
// clause, so the island never loads the module and the island tree is
// complete without it.
import { installPatch } from "./patch.ts";
import { readThroughRequire } from "./read.ts";

installPatch();
// Satisfies read.ts's `Loader` without naming ./env.ts, so env.ts stays out of
// the program's module graph and is reached only through the type-only clause.
const load = async (specifier: string): Promise<unknown> => specifier;
console.log("reader:", readThroughRequire(load));
