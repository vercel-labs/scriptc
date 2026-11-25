// @normalize-pid
// spawn's timeout accepts any unsigned integer, so 2147483648 passes the
// launch check: Node's Timeout warns TimeoutOverflowWarning on a later tick
// ("... does not fit into a 32-bit signed integer.\nTimeout duration was
// set to 1."), sets the deadline to 1 ms, and the child takes the SIGTERM
// default there. The warning reaches the default stderr report with its
// one-time --trace-warnings hint.
import { spawn } from "node:child_process";

console.log("scheduled");

const child = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: "ignore", timeout: 2147483648 });
child.on("error", (e) => console.log("overflow", "error", e.name));
child.on("close", (code, signal) => console.log("overflow", code, signal));
