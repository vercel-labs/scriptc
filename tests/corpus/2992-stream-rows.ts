// Redirected stdio has no geometry. PTY reads and resize are covered by the
// terminal-geometry harness; both backends must also preserve undefined here.
const out = (process.stdout as typeof process.stdout & { rows?: number }).rows;
const err = (process.stderr as typeof process.stderr & { rows?: number }).rows;
console.log(out === undefined, err === undefined, out ?? 24, err ?? 48);
