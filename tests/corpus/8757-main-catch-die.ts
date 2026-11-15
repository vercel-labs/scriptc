// @exit: 1
// The last line of a script: `main().catch(die)`. The handler is a declared
// function, it reports the failure and sets the exit status.
import { readFile } from "node:fs/promises";

async function main(): Promise<void> {
  console.log("reading");
  const text = await readFile("/nonexistent/8757-main-catch-die.txt", "utf8");
  console.log("unreachable", text.length);
}

function die(error: unknown): void {
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  console.log("fatal:", code);
  process.exitCode = 1;
}

main().catch(die);
