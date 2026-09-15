// A duplex child pipe: stdout remains readable while stdin is fed.
// The harness supplies Node on PATH for the child on every native platform.
import { spawn } from "node:child_process";
const child = spawn(process.env.SCRIPTC_TEST_NODE || "node", ["-e", "process.stdin.on('data', b => process.stdout.write(b));"], { stdio: ["pipe", "pipe", "pipe"] });
let text = "";
let ended = false;
let exited = false;
let finished = false;
function report(): void {
  if (ended && exited && finished) console.log("echo", text, "closed", child.stdin?.writable);
}
child.stdout?.on("data", (data: Buffer) => { text += new TextDecoder().decode(data); });
child.stdout?.on("end", () => { ended = true; report(); });
child.on("exit", () => { exited = true; report(); });
child.on("error", (err: Error) => { console.log(err.message); });
child.stdin?.on("error", (err: Error) => { console.log(err.message); });
child.stdin?.on("finish", () => { finished = true; report(); });
console.log("writable", child.stdin?.writable);
child.stdin?.write("hello ");
child.stdin?.end(new Uint8Array([119, 111, 114, 108, 100]));
