// @exit: 3
// The process facts and hooks nearly every program reads: platform, arch
// and version, nextTick with arguments and its order against promise jobs,
// the standard streams' descriptors, an 'unhandledRejection' listener that
// receives the reason and the promise, and an 'exit' listener that sees
// the exit code the program set.
console.log(["darwin", "linux", "win32"].includes(process.platform), ["arm64", "x64"].includes(process.arch));
console.log(process.version.startsWith("v"), process.version.split(".").length, typeof process.versions.node);
console.log(process.pid > 0, process.ppid > 0, typeof process.title, process.release.name);
console.log(process.stdin.fd, process.stdout.fd, process.stderr.fd);

process.on("exit", (code) => console.log("exit", code, process.exitCode));

process.on("unhandledRejection", (reason, promise) => {
  console.log("unhandled", reason instanceof Error ? reason.message : String(reason), promise instanceof Promise);
});

process.nextTick((a: number, b: string) => console.log("tick", a, b), 1, "x");
Promise.resolve().then(() => console.log("promise"));
process.nextTick(() => {
  console.log("tick 2");
  process.nextTick(() => console.log("nested tick"));
});
console.log("sync");

setTimeout(() => {
  void Promise.reject(new Error("late"));
  process.exitCode = 3;
}, 1);
