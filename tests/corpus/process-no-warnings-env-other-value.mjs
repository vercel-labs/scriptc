// @env: NODE_NO_WARNINGS=0
// @normalize-pid
// Only the value "1" silences the default report: with any other value the
// warning is reported on stderr (the harness compares it without the
// process id) and listeners run as usual.
process.on("warning", (warning) => console.log("listener", warning.name, warning.message));
process.emitWarning("reported warning", "CustomWarning");
setTimeout(() => console.log("done"), 5);
