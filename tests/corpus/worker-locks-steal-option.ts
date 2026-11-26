// A shared lock cannot be stolen: Node refuses steal with a shared mode.
import { locks } from "node:worker_threads";

try {
  await locks.request("steal", { mode: "shared", steal: true }, () => 1);
} catch (error: any) {
  console.log("steal shared", error.name, error.message);
}
