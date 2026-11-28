// A signal cannot be combined with ifAvailable or steal: Node refuses the
// combination with a NotSupportedError DOMException.
import { locks } from "node:worker_threads";

try {
  await locks.request("sig", { signal: new AbortController().signal, ifAvailable: true }, () => 1);
} catch (error: any) {
  console.log("signal flags", error.name, error.message);
}
