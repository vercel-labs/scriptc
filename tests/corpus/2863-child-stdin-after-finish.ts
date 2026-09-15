import { spawn } from "node:child_process";
const child = spawn(process.env.SCRIPTC_TEST_NODE || "node", ["-e", "process.stdin.resume();setInterval(()=>{},1000);"], { stdio: ["pipe", "ignore", "ignore"] });
child.stdin?.on("error", (err: Error) => { console.log("error", err.message); child.kill(); });
child.on("error", (err: Error) => { console.log(err.message); });
child.stdin?.on("finish", () => { console.log("after-finish", child.stdin?.write("late")); });
child.stdin?.end();
