// @exit: 1
// @requires-libnode
// A spawn that fails in a Node island with no 'error' listener anywhere: the emitter's unhandled
// 'error' ends the program with status 1, as under Node, although a native 'close' listener is
// attached and another child of the island is still running with its stdin open.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const waiting: ChildProcess = lib.start("cat");
waiting.on("close", () => console.log("unreachable: cat closed"));
const child: ChildProcess = lib.start("/nonexistent/scriptc-island-child");
child.on("close", (code) => console.log("unreachable: close", code));
console.log("started", typeof waiting.pid, typeof child.pid);
