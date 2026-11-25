// The global console's honest fences: tables over Map and Set values,
// console.dir over a Buffer (custom inspection off) or with options that
// do not resolve at compile time, assert forms whose output would depend
// on a runtime format string or on skipped argument evaluation, and
// inspector-only members with object arguments. Every reached site
// terminates in a named diagnostic.
console.table(new Map([["k", 1]]));
console.table(new Set([1, 2]));

console.dir(Buffer.from([1, 2]));
const options = { depth: 1 };
console.dir({ a: 1 }, options);
console.dir({ a: 1 }, { customInspect: true });
console.dir({ a: 1 }, { showHidden: true });

function computed(): number {
  return 1;
}
console.assert(false, "value %d", computed());
const format = process.argv.length > 99 ? "%s" : "plain %s";
console.assert(false, format, "argument");
const message: string | number = process.argv.length > 99 ? "text" : 1;
console.assert(false, message);

console.profile({ label: "object" } as unknown as string);
