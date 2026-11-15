// A JavaScript module's named imports of the process module's data members
// are the member's values: an array read by length and index, strings and a
// number compared with the spelled reads.
import process, { argv, execArgv, execPath, pid, platform } from "node:process";

const kept = [];
for (let index = 0; index < execArgv.length; index += 1) {
  const option = execArgv[index];
  if (option === "--eval" || option === "-e") {
    if (!execArgv[index + 1]?.startsWith("-")) index += 1;
  } else {
    kept.push(option);
  }
}
console.log(Array.isArray(execArgv), kept.length <= execArgv.length);
console.log(argv === process.argv, argv.length >= 2);
console.log(execPath === process.execPath, platform === process.platform, pid === process.pid);

const { execArgv: sameOptions } = process;
console.log(Array.isArray(sameOptions), sameOptions.length === execArgv.length);
