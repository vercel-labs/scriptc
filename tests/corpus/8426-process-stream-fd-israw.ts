// The process streams' descriptors and stdin's raw-mode flag: fd is the
// compile-time 0/1/2 Node reports for a TTY, a pipe, and a redirected file
// alike; isRaw is the TTY's raw-mode flag and Node's undefined when stdin
// is not a terminal (the harness's own pipe).
import { writeSync } from "node:fs";

console.log("stdin fd", process.stdin.fd);
console.log("stdout fd", process.stdout.fd);
console.log("stderr fd", process.stderr.fd);
console.log("stdin isRaw", process.stdin.isRaw, typeof process.stdin.isRaw);
writeSync(process.stdout.fd, "writeSync through process.stdout.fd\n");
