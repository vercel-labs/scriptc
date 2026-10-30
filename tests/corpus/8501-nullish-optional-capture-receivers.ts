// `(x ?? fallback).method(...)` over storage the checker types
// `T | undefined`: the default takes over exactly when the stored value is
// absent — an optional record field, an optional parameter, a callback
// parameter, and an unchecked element read.

interface Options {
  tools?: string[];
}

const DEFAULTS = ["read", "write"];

function active(options: Options): string[] {
  const selected = options.tools;
  return (selected ?? DEFAULTS).filter((name) => name !== "write");
}

function collect(...failures: Array<string[] | undefined>): string[] {
  return failures.flatMap((entries) => (entries ?? []).map((entry) => entry.toUpperCase()));
}

function totals(groups: number[][] | undefined): number {
  return (groups ?? []).reduce((sum, group) => sum + group.length, 0);
}

console.log(active({ tools: ["read", "write"] }).join(","));
console.log(active({}).join(","));
console.log(collect(["a"], undefined, ["b"]).join(","));
console.log(totals([[1, 2], [3]]), totals(undefined));
