import { spawn } from "node:child_process";
const child = spawn(process.env.SCRIPTC_TEST_NODE || "node", ["-e", "setTimeout(() => process.exit(0), 100);"], { stdio: ["pipe", "ignore", "ignore"] });
child.on("error", (err: Error) => { console.log(err.message); });
child.stdin?.on("error", (err: Error) => { console.log(err.message); });
child.on("exit", (code) => {
  console.log("exit", code, "writable", child.stdin?.writable);
});
