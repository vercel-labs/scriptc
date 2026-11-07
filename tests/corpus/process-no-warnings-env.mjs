// @env: NODE_NO_WARNINGS=1
// NODE_NO_WARNINGS=1 leaves out the default report of a process warning on
// stderr; 'warning' listeners still receive every warning.
process.on("warning", (warning) => {
  console.log("listener", warning.name, warning.message, warning.code ?? "no code");
});
process.emitWarning("first warning");
process.emitWarning("second", "DeprecationWarning", "DEP0000");
process.emitWarning("third", { type: "CustomWarning", code: "C1", detail: "some detail" });
process.emitWarning(new Error("an error as a warning"));
setTimeout(() => console.log("done"), 5);
