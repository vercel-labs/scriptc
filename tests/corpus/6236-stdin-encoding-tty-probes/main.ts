// pi-tui's terminal setup on a piped stdin: the `if (process.stdin.setRawMode)`
// presence check (the method exists only on a TTY), setEncoding with a
// string 'data' listener whose chunks keep multibyte characters split
// across writes whole, and stdout 'resize' listeners (registered,
// removed, never fired off a TTY). The program re-runs itself with a
// pipe so the parent controls the write boundaries.
import { spawn } from "node:child_process";

if (process.argv[2] === "child") {
  console.log("raw present", typeof process.stdin.setRawMode, Boolean(process.stdin.setRawMode));
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  const onResize = (): void => console.log("resize", process.stdout.columns);
  process.stdout.on("resize", onResize);
  process.stdout.once("resize", onResize);
  process.stdout.removeListener("resize", onResize);
  let total = "";
  let replacement = false;
  process.stdin.on("data", (data: string) => {
    if (typeof data !== "string") console.log("not a string");
    if (data.includes("�")) replacement = true;
    total += data;
  });
  process.stdin.on("end", () => {
    console.log("end", JSON.stringify(total), "replacement", replacement);
    process.stdout.removeListener("resize", onResize);
  });
  process.stdin.resume();
  // Off a TTY no stream listens for SIGWINCH and its default is to ignore.
  process.kill(process.pid, "SIGWINCH");
} else {
  const child = spawn(process.execPath, [process.argv[1]!, "child"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    out += chunk;
  });
  child.on("close", (code: number | null) => {
    process.stdout.write(out);
    console.log("child exit", code);
  });
  const parts = [
    Buffer.from([0x68, 0xc3]),
    Buffer.from([0xa9, 0x6c, 0x6c, 0x6f, 0x20, 0xe2, 0x82]),
    Buffer.from([0xac, 0x20, 0xf0, 0x9f]),
    Buffer.from([0x98, 0x80, 0x21]),
  ];
  let i = 0;
  const next = (): void => {
    if (i < parts.length) {
      const part: Buffer = parts[i]!;
      i++;
      child.stdin!.write(part);
      setTimeout(next, 30);
    } else {
      child.stdin!.end();
    }
  };
  next();
}
