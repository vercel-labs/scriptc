// @exit: 2
// The exit status follows process.exitCode when the program ends normally.
function settle(failed: boolean): void {
  if (failed) process.exitCode = process.exitCode ?? 2;
}
console.log("start", process.exitCode === undefined);
settle(true);
settle(true);
console.log("code", process.exitCode);
process.on("exit", () => console.log("exiting with", process.exitCode));
