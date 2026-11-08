// A function passed by name as a child's 'close' listener that declares the
// exit code as `number` is not called with the null Node passes when a
// signal ended the child: a TypeError says so instead (Node calls the
// function with null and prints "tally 1").
import { spawn } from "node:child_process";

const tally = (code: number) => {
  console.log(`tally ${code + 1}`);
};

const chore = spawn("sh", ["-c", "kill -TERM $$"]);
chore.on("close", tally);
