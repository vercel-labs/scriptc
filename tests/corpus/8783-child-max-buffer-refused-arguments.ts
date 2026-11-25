// A capturing launch that is given both an invalid maxBuffer and a value
// Node refuses (a NUL in the file, the command, an argument, cwd or the
// environment) throws the error Node's own order reaches first. spawnSync,
// which execSync and execFileSync call, checks the launch's values and then
// the limit. execFile checks the limit and then calls spawn, which checks
// the values. exec checks its command, then calls execFile. The promisified
// forms throw from the call, like the functions they wrap.
//
// A launch that was refused leaves its limit behind for no other capture.
//
// Node has the value of every option before it checks anything, so a
// maxBuffer expression that adds an argument has added it when the
// arguments are checked.
import { exec, execFile, execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Values the compiler does not know.
const nul: string = ["a", "b"].join("\0");
const bad: number = Number(process.argv[2] ?? "-1");
const small: number = Number(process.argv[3] ?? "4");
const dir: string = tmpdir();
const notCalled = (): void => console.log("not called");

// A limit whose computation appends an argument Node refuses.
function growing(list: string[], limit: number): number {
  list.push(nul);
  return limit;
}

function thrown(label: string, launch: () => unknown): void {
  try {
    launch();
    console.log(label, "returned");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
  }
}

async function main(): Promise<void> {
  // Synchronous: the values, then the limit.
  thrown("execFileSync file", () => execFileSync(nul, [], { maxBuffer: bad }));
  thrown("execFileSync argument", () => execFileSync("/bin/echo", [nul], { maxBuffer: bad }));
  thrown("execFileSync cwd", () => execFileSync("/bin/echo", ["x"], { cwd: nul, maxBuffer: bad }));
  thrown("execFileSync env", () =>
    execFileSync("/bin/echo", ["x"], { env: { A: nul }, maxBuffer: bad }),
  );
  thrown("execFileSync limit", () => execFileSync("/bin/echo", ["x"], { maxBuffer: bad }));
  thrown("execSync command", () => execSync("echo " + nul, { maxBuffer: bad }));
  thrown("execSync cwd", () => execSync("echo x", { cwd: nul, maxBuffer: bad }));
  thrown("execSync limit", () => execSync("echo x", { cwd: dir, maxBuffer: bad }));

  // execFile: the limit, then the values.
  thrown("execFile file", () => execFile(nul, [], { maxBuffer: bad }, notCalled));
  thrown("execFile argument", () => execFile("/bin/echo", [nul], { maxBuffer: bad }, notCalled));
  thrown("execFile cwd", () =>
    execFile("/bin/echo", ["x"], { cwd: nul, maxBuffer: bad }, notCalled),
  );
  thrown("execFile shell", () => execFile(nul, [], { shell: true, maxBuffer: bad }, notCalled));
  thrown("execFile file, valid limit", () => execFile(nul, [], { maxBuffer: small }, notCalled));
  thrown("execFile cwd, valid limit", () =>
    execFile("/bin/echo", ["x"], { cwd: nul, maxBuffer: small }, notCalled),
  );

  // exec: the command, the limit, then the options.
  thrown("exec command", () => exec("echo " + nul, { maxBuffer: bad }, notCalled));
  thrown("exec cwd", () => exec("echo x", { cwd: nul, maxBuffer: bad }, notCalled));
  thrown("exec command and cwd", () =>
    exec("echo " + nul, { cwd: nul, maxBuffer: bad }, notCalled),
  );
  thrown("exec cwd, valid limit", () => exec("echo x", { cwd: nul, maxBuffer: small }, notCalled));

  // Promisified: the same orders, thrown where the call is made.
  thrown("promisified execFile file", () => void execFileAsync(nul, [], { maxBuffer: bad }));
  thrown("promisified execFile env", () =>
    void execFileAsync("/bin/echo", ["x"], { env: { A: nul }, maxBuffer: bad }),
  );
  thrown("promisified execFile file, valid limit", () =>
    void execFileAsync(nul, [], { maxBuffer: small }),
  );
  thrown("promisified exec command", () => void execAsync("echo " + nul, { maxBuffer: bad }));
  thrown("promisified exec cwd", () => void execAsync("echo x", { cwd: nul, maxBuffer: bad }));
  thrown("promisified exec env", () =>
    void execAsync("echo x", { env: { A: nul }, maxBuffer: bad }),
  );
  thrown("promisified exec cwd, valid limit", () =>
    void execAsync("echo x", { cwd: nul, maxBuffer: small }),
  );

  // The limit's expression runs before the arguments are checked.
  const forSync = ["x"];
  thrown("execFileSync, limit adds an argument", () =>
    execFileSync("/bin/echo", forSync, { maxBuffer: growing(forSync, 64) }),
  );
  const forCallback = ["x"];
  thrown("execFile, limit adds an argument", () =>
    execFile("/bin/echo", forCallback, { maxBuffer: growing(forCallback, 64) }, notCalled),
  );
  const forPromise = ["x"];
  thrown("promisified execFile, limit adds an argument", () =>
    void execFileAsync("/bin/echo", forPromise, { maxBuffer: growing(forPromise, 64) }),
  );
  console.log("lists:", forSync.length, forCallback.length, forPromise.length);

  // The refused launches above named a limit of four. The captures below
  // name none, so Node's default applies and ten bytes fit.
  console.log("after refusals, execSync:", execSync("printf abcdefghij", { encoding: "utf8" }).length);
  const later = await execAsync("printf abcdefghij");
  console.log("after refusals, promisified exec:", later.stdout.length);
  await new Promise<void>((resolve) => {
    execFile("/bin/sh", ["-c", "printf abcdefghij"], (error, stdout) => {
      console.log("after refusals, execFile:", error === null, stdout.length);
      resolve();
    });
  });

  // A launch whose values are checked and pass still has its limit.
  thrown("checked execSync over its limit", () =>
    execSync("printf abcdefghij", { cwd: dir, maxBuffer: small, encoding: "utf8" }),
  );
  console.log(
    "checked execSync at its limit:",
    execSync("printf abcd", { cwd: dir, maxBuffer: small, encoding: "utf8" }),
  );
  await new Promise<void>((resolve) => {
    exec("printf abcdefghij", { cwd: dir, maxBuffer: small }, (error, stdout) => {
      const e = error as (Error & { code?: string | number }) | null;
      console.log("checked exec over its limit:", e?.name, e?.code, JSON.stringify(stdout));
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    execFile("/bin/sh", ["-c", "printf abcdefghij"], { cwd: dir, maxBuffer: small }, (error, stdout) => {
      const e = error as (Error & { code?: string | number }) | null;
      console.log("checked execFile over its limit:", e?.name, e?.code, JSON.stringify(stdout));
      resolve();
    });
  });
  try {
    await execAsync("printf abcdefghij", { cwd: dir, maxBuffer: small });
    console.log("checked promisified exec resolved");
  } catch (error) {
    const e = error as Error & { code?: string | number; stdout?: string };
    console.log("checked promisified exec over its limit:", e.name, e.code, JSON.stringify(e.stdout));
  }
}
main();
