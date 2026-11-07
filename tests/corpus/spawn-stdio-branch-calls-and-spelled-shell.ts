// Two things spawn's options must not lose.
//
// A stdio slot written as a conditional evaluates the branch it takes: a
// call whose return type is one of the literals still runs, with its side
// effects and its exceptions, although the type alone names the mode.
//
// `shell: (true)` and `shell: true as boolean` are the literal `true`: the
// command line runs through the shell, not as a file name.
import { spawn } from "node:child_process";

let calls = 0;
function quiet(): "ignore" {
  calls++;
  return "ignore";
}
function unavailable(): "pipe" {
  throw new Error("mode unavailable");
}

function output(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let text = "";
  child.stdout?.on("data", (chunk) => {
    text += String(chunk);
  });
  return new Promise<void>((resolve) => {
    child.on("error", (error) => {
      console.log(label, "error", (error as NodeJS.ErrnoException).code);
      resolve();
    });
    child.on("close", (code) => {
      console.log(label, code, JSON.stringify(text));
      resolve();
    });
  });
}

const taken = process.argv.length > 0;

await output(
  spawn("/bin/sh", ["-c", "printf out; printf err >&2"], {
    stdio: ["ignore", "pipe", taken ? quiet() : "pipe"],
  }),
  "branch call",
);
console.log("calls", calls);

await output(
  spawn("/bin/sh", ["-c", "printf other"], {
    stdio: ["ignore", "pipe", taken ? "ignore" : quiet()],
  }),
  "branch not taken",
);
console.log("calls", calls);

try {
  await output(
    spawn("/bin/sh", ["-c", "printf never"], {
      stdio: ["ignore", taken ? unavailable() : "ignore", "ignore"],
    }),
    "branch throw",
  );
  console.log("no throw");
} catch (error) {
  console.log("threw", (error as Error).message);
}

await output(
  spawn("printf paren-shell", [], { stdio: ["ignore", "pipe", "ignore"], shell: (true) }),
  "paren",
);
await output(
  spawn("printf cast-shell", [], { stdio: ["ignore", "pipe", "ignore"], shell: true as boolean }),
  "cast",
);
await output(
  spawn("/bin/echo", ["no", "shell"], { stdio: ["ignore", "pipe", "ignore"], shell: (false) }),
  "paren false",
);
