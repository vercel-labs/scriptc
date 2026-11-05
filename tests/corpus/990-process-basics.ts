// process basics: platform, argv shape/identity/mutation, cwd. The
// argv[0]/argv[1] VALUES differ between Node and scriptc (documented
// divergence — positions and length match), so only shape and identity
// properties print; cwd itself prints because both sides run in one cwd.
const platform = process.platform;
console.log(platform === "darwin" || platform === "linux" || platform === "win32");
console.log(platform.length > 0, platform === process.platform);

// One stable interned array, exactly like Node's process.argv.
console.log(process.argv === process.argv);
const argv = process.argv;
console.log(argv === process.argv);
console.log(argv.length); // [runtime, program] — 2 on both sides
console.log(argv[0].length > 0, argv[1].length > 0);
// Mutations persist across reads (it is ONE array, not a fresh copy).
argv.push("extra");
console.log(process.argv.length, process.argv[2] === "extra");
process.argv.pop();
console.log(argv.length);

// argv through ordinary array machinery.
let nonEmpty = 0;
for (const a of process.argv) {
  if (a.length > 0) {
    nonEmpty = nonEmpty + 1;
  }
}
console.log(nonEmpty === process.argv.length);

// cwd: a fresh string per call, equal by content, absolute.
const cwd = process.cwd();
console.log(cwd);
console.log(cwd === process.cwd(), cwd.startsWith("/"));

// A stdlib-global snapshot (`const proc = globalThis.process`) lowers to
// alias plumbing — no storage, no code — and reads through it resolve to
// the global itself.
const proc = globalThis.process;
console.log(proc.pid === process.pid, proc.platform === process.platform);
console.log(proc.argv === process.argv);
