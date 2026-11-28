// ifAvailable and steal are mutually exclusive: Node refuses the combination
// with a NotSupportedError DOMException.
import { locks } from "node:worker_threads";

try {
  await locks.request("both", { ifAvailable: true, steal: true }, () => 1);
} catch (error: any) {
  console.log("mutual", error.name, error.message);
}
