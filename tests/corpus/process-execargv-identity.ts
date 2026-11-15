// process.execArgv is one array, like process.argv: every read answers the
// same object, and a change through one read is seen by the next.
console.log(process.execArgv === process.execArgv, process.argv === process.argv);
const before = process.execArgv.length;
process.execArgv.push("--added");
console.log(process.execArgv.length - before, process.execArgv[process.execArgv.length - 1]);

const held = process.execArgv;
const again = process.execArgv;
console.log(held === again, held.includes("--added"));
function extend(list: string[]): number {
  list.push("--more");
  return list.length;
}
console.log(extend(process.execArgv) === process.execArgv.length, held.length - before);
held.length = before;
console.log(process.execArgv.length === before, again.includes("--added"));

console.log(process.versions === process.versions, process.release === process.release);
const release = process.release;
console.log(release === process.release, release.name);
