// @exit: 5
// process.exit() without an argument keeps process.exitCode.
process.exitCode = 5;
process.on("exit", (code) => console.log("exit", code, process.exitCode));
process.exit();
