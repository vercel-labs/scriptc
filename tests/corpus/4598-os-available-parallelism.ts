// os.availableParallelism() — differential against the host's own Node:
// libuv's uv_available_parallelism (the CPU affinity mask, then a smaller
// cgroup CPU quota on Linux; hw.activecpu on Darwin), so both processes
// see the same count.
import * as os from "node:os";
import { availableParallelism } from "node:os";

const n = os.availableParallelism();
console.log(typeof n, Number.isInteger(n), n >= 1);
console.log(n === availableParallelism());
console.log(n);
// A thread count derived from it, like a parallel tool's default.
console.log(Math.max(1, Math.min(n, 64)) === n || n > 64);
