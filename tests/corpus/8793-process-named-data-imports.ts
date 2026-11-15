// Named imports of the process module's data members read what the spelled
// `process.<member>` reads: the same argument array, the same strings and
// numbers.
import process, { arch, argv, execArgv, execPath, pid, platform } from "node:process";

console.log(argv === process.argv, argv.length >= 2);
console.log(Array.isArray(execArgv), execArgv.every((option) => typeof option === "string"));
console.log(execPath === process.execPath, typeof execPath);
console.log(platform === process.platform, arch === process.arch, pid === process.pid);

// The options a child Node process would inherit: every option but the ones
// that run code, read by index like any other string array.
const kept: string[] = [];
for (let index = 0; index < execArgv.length; index += 1) {
  const option = execArgv[index]!;
  if (option === "--eval" || option === "-e") {
    if (!execArgv[index + 1]?.startsWith("-")) index += 1;
  } else {
    kept.push(option);
  }
}
console.log(kept.length <= execArgv.length);
