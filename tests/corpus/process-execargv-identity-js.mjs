// process.execArgv and process.release through the spelled read, a named
// import and a destructured binding are the same objects, as in Node.
import { argv, execArgv, release, versions } from "node:process";

console.log(process.execArgv === process.execArgv, execArgv === process.execArgv);
const { execArgv: destructured, release: held } = process;
console.log(destructured === execArgv, destructured === process.execArgv);

const before = execArgv.length;
execArgv.push("--added");
console.log(process.execArgv.length - before, destructured.includes("--added"));
process.execArgv.pop();
console.log(execArgv.length === before, destructured.length === before);

console.log(argv === process.argv, versions === process.versions);
console.log(release === process.release, held === release, release.name);
