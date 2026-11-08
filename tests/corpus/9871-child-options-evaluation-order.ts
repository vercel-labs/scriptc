// exec, execFile and their synchronous and promisified forms take their
// options as an object literal, and an object literal evaluates its members
// in the order they are written: after the file or command and the argument
// list, and before a callback that follows it. So a `maxBuffer` written
// before `cwd` is evaluated before it, reads its binding before a later
// member assigns it, and its exception wins over a later member's.
import { exec, execFile, execFileSync, execSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const order: string[] = [];
function num(label: string, value: number): number {
  order.push(label);
  return value;
}
function str(label: string, value: string): string {
  order.push(label);
  return value;
}
function list(label: string, value: string[]): string[] {
  order.push(label);
  return value;
}
function evaluated(): string {
  const text = order.join(" > ");
  order.length = 0;
  return text;
}
function failNum(label: string): number {
  if (label.length > 0) throw new Error(label);
  return 0;
}
function failStr(label: string): string {
  if (label.length > 0) throw new Error(label);
  return "";
}
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const e = error as Error & { code?: string };
    return e.code === undefined ? e.message : `${e.code}`;
  }
  return "no error";
}
function reporter(done: (line: string) => void): (error: Error | null, stdout: string) => void {
  order.push("callback");
  return (error, stdout) => {
    done(`${error === null ? "ok" : error.message} ${JSON.stringify(stdout)}`);
  };
}

function limitFirst(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      str("file", "/bin/echo"),
      list("args", ["one"]),
      { maxBuffer: num("maxBuffer", 1024), cwd: str("cwd", "/") },
      reporter(resolve),
    );
  });
}
function limitLast(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      str("file", "/bin/echo"),
      list("args", ["two"]),
      { cwd: str("cwd", "/"), maxBuffer: num("maxBuffer", 1024) },
      reporter(resolve),
    );
  });
}
function shellLimitFirst(): Promise<string> {
  return new Promise((resolve) => {
    exec(
      str("command", "echo three"),
      { maxBuffer: num("maxBuffer", 1024), cwd: str("cwd", "/") },
      reporter(resolve),
    );
  });
}

// The limit is a local that a later member assigns: Node has read it.
let limit = 64;
function lowersLimit(directory: string): string {
  limit = -1;
  return directory;
}
function heldLimit(): Promise<string> {
  return new Promise((resolve) => {
    execFile("/bin/echo", ["four"], { maxBuffer: limit, cwd: lowersLimit("/") }, (error, stdout) => {
      resolve(`${error === null ? "ok" : error.message} ${JSON.stringify(stdout)}`);
    });
  });
}

async function main(): Promise<void> {
  console.log("execFile, limit first:", await limitFirst(), "|", evaluated());
  console.log("execFile, limit last:", await limitLast(), "|", evaluated());
  console.log("exec, limit first:", await shellLimitFirst(), "|", evaluated());

  console.log("held limit:", await heldLimit(), limit);
  limit = 64;
  console.log(
    "held limit, sync:",
    JSON.stringify(
      execFileSync("/bin/echo", ["five"], { maxBuffer: limit, cwd: lowersLimit("/"), encoding: "utf8" }),
    ),
    limit,
  );

  // The first member that throws is the one the call throws.
  console.log(
    "throws, limit first:",
    thrown(() =>
      execFile("/bin/echo", ["x"], { maxBuffer: failNum("limit"), cwd: failStr("cwd") }, () => {}),
    ),
  );
  console.log(
    "throws, limit last:",
    thrown(() =>
      execFile("/bin/echo", ["x"], { cwd: failStr("cwd"), maxBuffer: failNum("limit") }, () => {}),
    ),
  );
  console.log(
    "throws, sync:",
    thrown(() =>
      execFileSync("/bin/echo", ["x"], { maxBuffer: failNum("limit"), cwd: failStr("cwd") }),
    ),
    thrown(() => execSync("echo x", { cwd: failStr("cwd"), maxBuffer: failNum("limit") })),
  );
  // A limit Node refuses is refused after every member was evaluated.
  console.log(
    "refused limit:",
    thrown(() =>
      execFile("/bin/echo", ["x"], { maxBuffer: num("maxBuffer", -1), cwd: str("cwd", "/") }, () => {}),
    ),
    "|",
    evaluated(),
  );

  console.log(
    "execFileSync:",
    JSON.stringify(
      execFileSync(str("file", "/bin/cat"), list("args", []), {
        timeout: num("timeout", 5000),
        maxBuffer: num("maxBuffer", 1024),
        input: str("input", "six"),
        cwd: str("cwd", "/"),
        encoding: "utf8",
      }),
    ),
    "|",
    evaluated(),
  );
  console.log(
    "execSync:",
    JSON.stringify(
      execSync(str("command", "echo seven"), {
        cwd: str("cwd", "/"),
        maxBuffer: num("maxBuffer", 1024),
        timeout: num("timeout", 5000),
        encoding: "utf8",
      }),
    ),
    "|",
    evaluated(),
  );

  const eight = await execFileAsync(str("file", "/bin/echo"), list("args", ["eight"]), {
    maxBuffer: num("maxBuffer", 1024),
    timeout: num("timeout", 5000),
    cwd: str("cwd", "/"),
  });
  console.log("promisified execFile:", JSON.stringify(eight.stdout), "|", evaluated());
  const nine = await execAsync(str("command", "echo nine"), {
    timeout: num("timeout", 5000),
    maxBuffer: num("maxBuffer", 1024),
    cwd: str("cwd", "/"),
  });
  console.log("promisified exec:", JSON.stringify(nine.stdout), "|", evaluated());
}

void main();
