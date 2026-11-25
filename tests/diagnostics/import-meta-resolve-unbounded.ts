// import.meta.resolve of a specifier the build cannot bound stays refused:
// an exported function's parameter (any importer may pass a value), and a
// value read at run time. (Bounded specifiers compile:
// tests/corpus/import-meta-resolve-bounded/main.ts.)
export function fromAnyCaller(specifier: string): string {
  return import.meta.resolve(specifier);
}

function fromArgv(): string {
  return import.meta.resolve(process.argv[2] ?? "node:fs");
}

console.log(fromAnyCaller("node:fs"), fromArgv());
