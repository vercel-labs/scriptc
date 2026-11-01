// A stdio SLOT may be a runtime expression whose type is a union of the
// supported literals: the value evaluates once and maps to its mode at the
// call ("ignore" — the child gets /dev/null, "pipe" — the parent holds the
// stream, "inherit" — the fd passes through). The literal slots keep their
// compile-time modes; the computed slot rides the same runtime mapping.
import { spawn } from "node:child_process";

type Mode = "pipe" | "ignore" | "inherit";

function run(mode: Mode): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn("/bin/sh", ["-c", "printf 'from-child\\n'"], {
      stdio: [mode, mode, mode],
    });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -2));
  });
}

async function main(): Promise<void> {
  // "inherit" passes the child's stdout through, so the line appears.
  console.log(`inherit: ${await run("inherit")}`);
  // "ignore" and "pipe" swallow it.
  console.log(`ignore: ${await run("ignore")}`);
  console.log(`pipe: ${await run("pipe")}`);

  // The inline ternary form (the census site): one computed slot, two
  // literal ones.
  const useStdin = process.argv.length > 99;
  const code = await new Promise<number>((resolve) => {
    const child = spawn("/bin/sh", ["-c", "printf 'ternary\\n'"], {
      cwd: process.cwd(),
      detached: false,
      stdio: [useStdin ? "pipe" : "inherit", useStdin ? "pipe" : "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", () => resolve(-1));
    child.on("exit", (exitCode) => resolve(exitCode ?? -2));
  });
  console.log(`ternary: ${code}`);
}

void main();
