// The typed calls report the same EISDIR: no path in the message, and no
// path property for an untyped view of the error to find.
import * as fs from "node:fs";
import * as os from "node:os";

const dir = os.tmpdir();

function show(label: string, error: unknown): void {
  if (!(error instanceof Error)) {
    console.log(label, "not an error");
    return;
  }
  const view: any = error;
  console.log(label, error.name, error.message, view.code, view.syscall, view.path);
}

try {
  const text: string = fs.readFileSync(dir, "utf8");
  console.log("readFileSync utf8: no throw", text.length);
} catch (error) {
  show("readFileSync utf8", error);
}
try {
  const bytes = fs.readFileSync(dir);
  console.log("readFileSync: no throw", bytes.length);
} catch (error) {
  show("readFileSync", error);
}

async function main(): Promise<void> {
  try {
    const text = await fs.promises.readFile(dir, "utf8");
    console.log("promises.readFile: no rejection", text.length);
  } catch (error) {
    show("promises.readFile", error);
  }
  fs.readFile(dir, "utf8", (error: Error | null) => {
    show("readFile", error);
  });
}
void main();
