// @exit: 7
// process.exitCode: unset reads undefined, assignments (including 0) read back,
// and process.exit(n) assigns the code before 'exit' listeners run.
console.log("initial", process.exitCode);
process.on("exit", (code) => {
  console.log("exit listener", code, process.exitCode);
});
process.exitCode = 0;
console.log("after 0", process.exitCode);
process.exitCode = 4;
const seen = process.exitCode;
console.log("after 4", seen, typeof process.exitCode);
process.exitCode = process.exitCode ?? 9;
console.log("kept", process.exitCode);
try {
  process.exitCode = 1.5;
} catch (e) {
  console.log("rejected", (e as Error).message, process.exitCode);
}
setTimeout(() => {
  process.exit(7);
}, 1);
