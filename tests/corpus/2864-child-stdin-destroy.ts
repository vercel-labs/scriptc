import { spawn } from "node:child_process";
const child = spawn(process.env.SCRIPTC_TEST_NODE || "node", ["-e", "process.stdin.resume();"], { stdio: ["pipe", "ignore", "ignore"] });
child.on("error", (err: Error) => { console.log(err.message); });
child.stdin?.on("error", (err: Error) => { console.log(err.message); });
child.on("exit", (code) => { console.log("exit", code); });
child.stdin?.destroy();
console.log("destroyed", child.stdin?.writable, child.stdin?.write("ignored"));
