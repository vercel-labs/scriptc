import { spawn } from "node:child_process";

/* write(chunk, callback): the completion callback runs once the pipe took
 * the chunk — here it ends stdin, which lets cat finish. */
const child = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
const input = child.stdin;
const output = child.stdout;
if (input === null || output === null) throw new Error("missing pipe");
let text = "";
output.on("data", (chunk) => {
  text += String(chunk);
});
input.on("error", (err) => console.log("error", err.message));
const returned = input.write("hello\n", (error) => {
  console.log("wrote", error === null || error === undefined);
  input.write("again\n", (second) => {
    console.log("wrote again", second === null || second === undefined);
    input.end();
  });
});
console.log("returned", returned);
child.on("exit", (code) => console.log("exit", code, JSON.stringify(text)));
