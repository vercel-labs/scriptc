// @exit: 1
// The 'warning' event and process.emitWarning's argument grammar:
// (message), (message, type), (message, type, code), (message, options)
// with type/code/detail, and an Error instance. Listeners receive Node's
// warning object (name, message, code, detail, instanceof Error); warnings
// dispatch after the current turn's synchronous output; removeListener
// removes by identity; a wrong warning kind throws ERR_INVALID_ARG_TYPE at
// the call.
const seen = [];
const record = (warning) => {
  seen.push(
    [
      warning.name,
      warning.message,
      warning.code,
      warning.detail,
      warning instanceof Error,
    ].join(":"),
  );
};
const removed = () => seen.push("removed");
process.on("warning", record);
process.on("warning", removed);
process.removeListener("warning", removed);

try {
  process.emitWarning(1);
} catch (error) {
  console.log("bad", error.code, error.name, error instanceof TypeError);
}
console.log("before dispatch");
process.emitWarning("plain");
process.emitWarning("typed", "CustomWarning");
process.emitWarning("coded", "CodeWarning", "W042");
process.emitWarning("detailed", { type: "OptionWarning", code: "W043", detail: "more" });
const asError = new Error("as error");
process.emitWarning(asError);
process.exitCode = 1;
process.once("exit", () => console.log(seen.join(" ; ")));
