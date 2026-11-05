// Builtins without a lowered value refuse at compile time in TypeScript,
// including as object literal members.
function take(x: unknown): unknown {
  return x;
}

const inferred = { json: JSON };
const loose: any = { escape: escape };
const timers: Record<string, unknown> = { setTimeout };
const list: any[] = [Array, parseInt];
console.log(inferred, loose, timers, list, take(process));
