// process.stdin/stdout/stderr and their fd numbers: the standard streams
// are three stable objects on descriptors 0, 1 and 2. Each is an object
// with a numeric fd and Node's stream methods, stdin reads and the two
// output streams write; the fd is a plain number on all platforms.
const fds = [process.stdin.fd, process.stdout.fd, process.stderr.fd];
console.log("fd", fds.join(","), fds.every((fd) => typeof fd === "number" && Number.isInteger(fd) && fd >= 0));
console.log("distinct", process.stdin !== process.stdout, process.stdout !== process.stderr, process.stdin !== process.stderr);
console.log("stable", process.stdin === process.stdin, process.stdout === process.stdout, process.stderr === process.stderr);
console.log("objects", typeof process.stdin, typeof process.stdout, typeof process.stderr);
console.log("methods", typeof process.stdin.on, typeof process.stdout.on, typeof process.stderr.on);
console.log("tty", typeof process.stdout.isTTY, typeof process.stderr.isTTY, typeof process.stdin.isTTY);
process.stdout.write("write-stdout\n");
process.stderr.write("write-stderr\n");
console.log("writable", process.stdout.writable !== false, process.stderr.writable !== false, process.stdin.readable !== false);
process.stdout.write("final\n");
