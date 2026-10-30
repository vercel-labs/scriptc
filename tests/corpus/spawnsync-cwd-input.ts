// spawnSync's cwd and input: the child starts in `cwd`, `input` is piped
// to its stdin ("| undefined" is an ABSENT option where "" pipes an empty
// stdin), a bad cwd fails the spawn with Node's shape (status null,
// error.code ENOENT, never a throw), and a large input must not deadlock —
// the pipe is fed in the same loop that drains stdout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-spawnsync-cwd-"));
writeFileSync(join(dir, "marker.txt"), "from-dir\n");

// cwd: the child resolves the relative path in ITS directory.
const inDir = spawnSync("cat", ["marker.txt"], { cwd: dir, encoding: "utf8" });
console.log(`cwd: ${JSON.stringify(inDir.stdout)} ${inDir.status}`);

// input: piped to stdin.
const fed = spawnSync("cat", [], { input: "hello\n", encoding: "utf8" });
console.log(`input: ${JSON.stringify(fed.stdout)} ${fed.status}`);

// "" is an EMPTY stdin (immediate EOF), distinct from an absent pipe.
const empty = spawnSync("cat", [], { input: "", encoding: "utf8" });
console.log(`empty: ${JSON.stringify(empty.stdout)}`);

// The optional-input idiom (`{ input }` over `string | undefined`, the
// census site): undefined is an ABSENT option (Node still pipes, so the
// child sees EOF) and "" pipes an empty stdin — both end at EOF, but a
// supplied value arrives, and the lowering must read the optional member
// without evaluating it twice.
const readLine = (input: string | undefined): string =>
  spawnSync("sh", ["-c", "read x && echo got:$x || echo eof"], { input, encoding: "utf8" })
    .stdout.trim();
const byteCount = (input: string | undefined): string =>
  spawnSync("wc", ["-c"], { input, encoding: "utf8" }).stdout.trim();
console.log(`optional: ${readLine(undefined)} ${readLine("")} ${readLine("abc\n")}`);
console.log(`optional bytes: ${byteCount(undefined)} ${byteCount("")} ${byteCount("abc")}`);

// stdio[0] "ignore" takes the child's fd 0 away (/dev/null), so Node drops
// `input` there instead of piping it — the mode decides, not the option.
const ignored = spawnSync("wc", ["-c"], {
  input: "dropped",
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
console.log(`ignored stdio: ${ignored.stdout.trim()} ${ignored.status}`);

// A large input must not deadlock: wc reads all of it before it answers,
// so the pipe has to be fed while stdout drains.
const counted = spawnSync("wc", ["-c"], {
  input: "x".repeat(65536),
  encoding: "utf8",
});
console.log(`large: ${counted.stdout.trim()}`);

// A cwd that does not exist fails the spawn: data, not a throw.
const bad = spawnSync("sh", ["-c", "true"], { cwd: "/definitely-not-a-directory-xyz" });
console.log(
  `bad cwd: ${bad.status} ${(bad.error as NodeJS.ErrnoException | undefined)?.code}`,
);

// The timeout still fires on this entry point (bounded: a 5s sleep dies
// to a 300ms SIGKILL).
const slow = spawnSync("sleep", ["5"], {
  input: "unread",
  timeout: 300,
  killSignal: "SIGKILL",
});
console.log(
  `timeout: ${slow.status} ${slow.signal} ${(slow.error as NodeJS.ErrnoException | undefined)?.code}`,
);

// cwd + input + env together: the replacement environment and the piped
// stdin reach a child that starts in cwd.
const all = spawnSync("sh", ["-c", "cat marker.txt; echo ${MARK:-unset}"], {
  cwd: dir,
  input: "unread\n",
  env: { MARK: "replaced" },
  encoding: "utf8",
});
console.log(`combined: ${JSON.stringify(all.stdout)} ${all.status}`);

// Every option expression evaluates exactly once, whatever the mode: Node
// reads `input` from the options object before stdio[0] decides whether the
// value is used, so a side-effecting input still runs when "ignore" takes
// the child's fd 0 away.
let evaluations = 0;
const computedInput = (): string => {
  evaluations++;
  return "dropped";
};
const ignoredInput = spawnSync("wc", ["-c"], {
  input: computedInput(),
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
console.log(
  `ignored input evaluated: ${evaluations} ${ignoredInput.stdout.trim()} ${ignoredInput.status}`,
);

// The optional-input idiom re-reads for the undefined test; a property
// read behind it is a getter, and Node runs the getter once.
class GetterInput {
  reads = 0;
  #value: string | undefined = "from-getter\n";
  get input(): string | undefined {
    this.reads++;
    return this.#value;
  }
}
const getterInput = new GetterInput();
const viaGetter = spawnSync("cat", [], { input: getterInput.input, encoding: "utf8" });
console.log(`optional getter: ${getterInput.reads} ${JSON.stringify(viaGetter.stdout)}`);

// The same one-read rule for a call in the option: the union-typed value is
// evaluated once and its undefined arm stays an absent option.
let calls = 0;
const optionalInput = (): string | undefined => {
  calls++;
  return calls === 1 ? "from-call\n" : undefined;
};
const viaCall = spawnSync("cat", [], { input: optionalInput(), encoding: "utf8" });
console.log(`optional call: ${calls} ${JSON.stringify(viaCall.stdout)}`);
