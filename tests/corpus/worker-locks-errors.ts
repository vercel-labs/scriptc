// Node's validation for a request: a name that starts with a hyphen, and an
// unknown lock mode, each with Node's own error name, code and message.
import { locks } from "node:worker_threads";

try {
  await locks.request("-bad" as string, () => 1);
} catch (error: any) {
  console.log("hyphen", error.name, error.message);
}
try {
  await locks.request("bad-mode", { mode: "nope" as any }, () => 1);
} catch (error: any) {
  console.log("mode", error.name, error.code, error.message);
}
