// spawnSync's `input` when stdio[0] is not a pipe: Node ignores the option
// ("ignore" is /dev/null, "inherit" the parent's fd 0), but evaluates the
// member before the call, so its side effects and exceptions still happen.
// The lowered form passes the value with has_input false instead of
// replacing the expression with an empty string.
import { spawnSync } from "node:child_process";

// The piped form keeps writing the input to the child's stdin.
const piped = spawnSync("/bin/cat", [], { encoding: "utf8", input: "kept" });
console.log(`piped: ${JSON.stringify(piped.stdout)} ${piped.status}`);

let reads = 0;
function chunk(): string {
  reads += 1;
  return "not written";
}

// The child does not read stdin, so the output is the same whether or not
// the input was handed over; the read count shows the expression ran.
const ignored = spawnSync("/bin/echo", ["ok"], {
  stdio: ["ignore", "pipe", "pipe"],
  input: chunk(),
  encoding: "utf8",
});
console.log(`ignore: ${JSON.stringify(ignored.stdout)} ${ignored.status} ${reads}`);

// "inherit" takes fd 0 the same way.
reads = 0;
const inherited = spawnSync("/bin/echo", ["ok"], {
  stdio: ["inherit", "pipe", "pipe"],
  input: chunk(),
  encoding: "utf8",
});
console.log(`inherit: ${JSON.stringify(inherited.stdout)} ${inherited.status} ${reads}`);

// An input expression that throws throws before the child starts.
function boom(): string {
  throw new Error("input evaluated");
}
try {
  spawnSync("/bin/echo", ["oops"], { stdio: ["ignore", "pipe", "pipe"], input: boom() });
  console.log("throw: none");
} catch (e) {
  console.log(`throw: ${(e as Error).message}`);
}
