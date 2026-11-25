// Under @types/node: the child_process options Node reads on Windows only.
// On every other target `windowsVerbatimArguments` and `windowsHide` are
// evaluated where they sit (a call among them runs, in member order) and
// change nothing. An `env` value that is checked-dynamic goes through the
// environment record's checked conversion, and a piped stdin typed as a
// stream ends with a `string | Buffer` chunk or with none.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const dark = process.argv.length > 9;
const steps: string[] = [];

function note(step: string, value: boolean): boolean {
  steps.push(step);
  return value;
}

function develop(label: string, start: () => ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const bath = start();
    let seen = "";
    bath.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    bath.on("close", (code, signal) => {
      console.log(label, JSON.stringify(seen), code, signal);
      resolve();
    });
  });
}

const command = "/bin/sh";
const args = ["-c", 'printf "%s|%s" "$PWD" "$TINT"'];
const raw: boolean | undefined = dark ? true : undefined;

function mix(): unknown {
  return { TINT: "selenium", PATH: "/usr/bin:/bin" };
}
const mixed = mix() as NodeJS.ProcessEnv;

async function main(): Promise<void> {
  await develop("verbatim false", () =>
    spawn(command, args, { cwd: "/", env: { TINT: "sepia" }, windowsVerbatimArguments: false }),
  );
  await develop("verbatim true", () =>
    spawn(command, args, { cwd: "/", env: { TINT: "cyan" }, windowsVerbatimArguments: true }),
  );
  await develop("verbatim maybe", () =>
    spawn(command, args, {
      cwd: "/",
      env: { TINT: "gold" },
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: raw,
    }),
  );
  await develop("evaluated in order", () =>
    spawn(command, args, {
      cwd: note("cwd", true) ? "/" : "/tmp",
      windowsVerbatimArguments: note("verbatim", false),
      env: { TINT: note("env", true) ? "umber" : "none" },
      windowsHide: note("hide", true),
    }),
  );
  console.log(steps.join(","));
  await develop("declared env", () => spawn(command, args, { cwd: "/", env: mixed }));

  function fix(note: string | Buffer | null): Promise<void> {
    return new Promise((resolve) => {
      const bath = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "inherit"] });
      let seen = "";
      bath.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
      });
      bath.on("close", (code) => {
        console.log("stdin", JSON.stringify(seen), code);
        resolve();
      });
      bath.stdin.on("error", () => {});
      bath.stdin.end(note);
    });
  }
  const packed: string | Buffer = dark ? "plain" : Buffer.from("packed\n");
  await fix(packed);
  await fix(dark ? "x" : null);
  await fix("text\n");

  await new Promise<void>((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", cwd: "/", windowsHide: true, windowsVerbatimArguments: raw },
      (error, stdout) => {
        console.log("execFile", error === null, JSON.stringify(stdout));
        resolve();
      },
    );
  });
}

void main();
