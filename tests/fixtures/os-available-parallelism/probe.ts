// os.availableParallelism(): the CPU count the process may use. The harness
// runs this in a namespace whose cgroup files it controls, so the number
// reflects the quota the scenario sets.
import { availableParallelism } from "node:os";

console.log(availableParallelism());
