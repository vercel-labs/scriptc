// util.getCallSites: the running source frames, top first, each naming the
// call site still running in it. The file is elided and the scriptId's
// value (a V8 script id; compiled programs have none) is shown by type, so
// the Node oracle and the compiled binary compare like for like.
import { getCallSites } from "node:util";

const self = "util-get-call-sites.ts";

function show(sites: { functionName: string; scriptName: string; scriptId: string; lineNumber: number; column: number }[]): string {
  const out: string[] = [];
  for (const site of sites) {
    const script = site.scriptName.split(/[\\/]/).pop() ?? "";
    if (script !== self) continue;
    out.push(`${site.functionName === "" ? "module" : site.functionName} ${site.lineNumber} ${site.column} ${typeof site.scriptId}`);
  }
  return out.join(" | ");
}

function inner(count?: number): string {
  return show(getCallSites(count));
}

function outer(count?: number): string {
  return inner(count);
}

function directName(): string {
  return getCallSites(1)[0].functionName;
}

class Named {
  name = "";
  constructor() {
    this.name = getCallSites(1)[0].functionName;
  }
  m(): string {
    return getCallSites(1)[0].functionName;
  }
  get p(): string {
    return getCallSites(1)[0].functionName;
  }
  static s(): string {
    return getCallSites(1)[0].functionName;
  }
}

console.log("two", show(getCallSites(2)));
console.log("nested", outer(3));
console.log("direct", directName());
const named = new Named();
console.log("labels", named.m(), named.name, Named.s(), named.p);
console.log("inner", outer(1));
console.log("options", show(getCallSites({ sourceMap: false })));
console.log("default", show(getCallSites()).length > 0);
console.log("no-frames", outer(1).split(" | ").length);

function attempt(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const problem = error as NodeJS.ErrnoException;
    console.log(label, problem.code, problem.message);
  }
}

attempt("zero", () => getCallSites(0));
attempt("high", () => getCallSites(201));
attempt("fraction", () => getCallSites(1.5));
attempt("string", () => getCallSites("3" as unknown as number));
attempt("null-options", () => getCallSites(null as unknown as number));
attempt("number-options", () => getCallSites(3, 5 as unknown as { sourceMap?: boolean }));
attempt("source-map", () => getCallSites(3, JSON.parse('{"sourceMap":"x"}')));
// An options bag without the key takes the default.
attempt("empty-options", () => getCallSites({}));
