// An embedded package's process.exitCode takes precedence over Node's
// fallback status 13 when top-level module evaluation remains pending.
import { deferNever, setExitCode } from "defer";

setExitCode(5);
console.log("pending with exit code");
await deferNever();
console.log("unreached");

export {};
