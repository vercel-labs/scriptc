// @exit: 3
// @requires-libnode
// process.exit from native code while the island has an interval, fs and
// thread-pool work, an open server and socket, a Worker and a child process:
// the exit is prompt and clean.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
lib.start();
process.on("exit", (code) => console.log(`exit ${code}`));
setTimeout(() => {
  console.log("exiting");
  process.exit(3);
}, 30);
