// @exit: 1
// A handler value that throws rejects the promise `catch` returned. With no
// handler on that promise the rejection is unhandled: the process reports
// it and exits with status 1, after the 'exit' listeners ran.
async function main(): Promise<void> {
  console.log("main started");
  throw new Error("fatal");
}
function rethrow(e: unknown): never {
  console.log("handler saw:", (e as Error).message);
  throw new RangeError("handler failed");
}
process.on("exit", (code) => console.log("exit listener, code", code));
main().catch(rethrow);
console.log("end of module");
