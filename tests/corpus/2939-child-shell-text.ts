import { spawn } from "node:child_process";

if (process.argv.at(2) === "utf8-child") {
  process.stdout.write(new Uint8Array([0xe2]));
  setTimeout(() => process.stdout.write(new Uint8Array([0x82, 0xac, 0x0a])), 25);
} else {
  shellPhase();
}

function shellPhase(): void {
  const command = process.platform === "win32" ? "echo hello" : "printf 'hello\\n'";
  const child = spawn(command, [], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = child.stdout!;
  const errors = child.stderr!;
  output.setEncoding("utf8");
  errors.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  const events: string[] = [];
  output.on("data", (chunk: string) => { stdout += chunk; });
  errors.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", (error) => { console.log("shell error", error.message); });
  child.once("exit", () => { events.push("exit"); });
  child.once("close", (code, signal) => {
    events.push("close");
    console.log("shell", stdout.trim(), stderr.length, code, signal, events.join(","));
    if (process.platform === "win32") {
      console.log("utf8 platform-covered");
      failurePhase();
    }
    else utf8Phase();
  });
}

function utf8Phase(): void {
  const child = spawn(process.execPath, [process.argv[1]!, "utf8-child"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = child.stdout!;
  output.setEncoding("utf8");
  let text = "";
  output.on("data", (chunk: string) => { text += chunk; });
  child.once("close", (code) => {
    console.log("utf8", JSON.stringify(text), code);
    failurePhase();
  });
}

function failurePhase(): void {
  const child = spawn("definitely-not-a-binary-shell-text", [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: string[] = [];
  child.once("error", () => { events.push("error"); });
  child.once("close", (code, signal) => {
    events.push("close");
    console.log("failure", code, signal, events.join(","));
    lateStdoutPhase();
  });
}

// Accessing stdout only after the reader reached EOF, while the child still
// runs: the late bridge reports Node's end and does not hold the child's
// 'close' on a stream whose read side is gone.
function lateStdoutPhase(): void {
  if (process.platform === "win32") {
    console.log("late stdout skipped");
    closedStdoutPhase();
    return;
  }
  const child = spawn("sh", ["-c", "true; sleep 0.3"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("exit", () => console.log("late exit"));
  child.once("close", (code) => {
    console.log("late closed", code);
    closedStdoutPhase();
  });
  setTimeout(() => {
    const output = child.stdout!;
    output.setEncoding("utf8");
    let text = "";
    output.on("data", (chunk: string) => { text += chunk; });
    output.on("end", () => console.log("late end", JSON.stringify(text)));
  }, 100);
}

// A child that has already closed leaves a late stdout inert, as Node's stdio
// does, and the late stream retains nothing.
function closedStdoutPhase(): void {
  if (process.platform === "win32") {
    console.log("closed stdout skipped");
    return;
  }
  const child = spawn("sh", ["-c", "true"], { stdio: ["ignore", "pipe", "pipe"] });
  child.once("close", (code) => {
    const output = child.stdout!;
    let ended = false;
    output.on("data", () => {});
    output.on("end", () => { ended = true; });
    setTimeout(() => console.log("closed stdout", code, ended), 50);
  });
}
