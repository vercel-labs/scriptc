// child.stdio is Node's one array per child: the piped handles at their
// slots — the same objects child.stdin/stdout/stderr answer — and null for
// every slot that is not a pipe.
const childProcess = require("node:child_process");

const piped = childProcess.spawn("echo", ["x"]);
console.log(
  "piped",
  piped.stdio.length,
  piped.stdio[0] === piped.stdin,
  piped.stdio[1] === piped.stdout,
  piped.stdio[2] === piped.stderr,
  piped.stdio[3] === undefined,
);
console.log("one per child", piped.stdio === piped.stdio, Array.isArray(piped.stdio));
piped.stdout.resume();

piped.on("close", () => {
  const ignored = childProcess.spawn("echo", ["y"], { stdio: "ignore" });
  console.log(
    "ignored",
    ignored.stdio.length,
    ignored.stdio[0] === null,
    ignored.stdio[1] === null,
    ignored.stdio[2] === null,
  );

  ignored.on("close", () => {
    const mixed = childProcess.spawn("echo", ["z"], { stdio: ["ignore", "pipe", "inherit"] });
    console.log(
      "mixed",
      mixed.stdio.length,
      mixed.stdio[0] === null,
      mixed.stdio[1] === mixed.stdout,
      mixed.stdio[2] === null,
      mixed.stdout !== null,
    );
    mixed.stdout.resume();
    mixed.on("close", () => {});
  });
});
