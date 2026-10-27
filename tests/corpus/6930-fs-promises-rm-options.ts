// fs.promises.rm with an options object: { recursive, force } and the
// maxRetries/retryDelay pair, as rmSync accepts them. Failures reject with
// Node's errors: a missing path without force, a directory without
// recursive (ERR_FS_EISDIR), and an out-of-range maxRetries or retryDelay.
// rmSync throws the same errors, checking its options before the path,
// while fs.promises.rm checks the path first.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-rm-"));

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(label, error.name, code, error.message.split(dir).join("<dir>"));
  } else {
    console.log(label, "non-error");
  }
}

async function settle(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (error) {
    report(label, error);
  }
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    report(label, error);
  }
}

function tree(root: string): void {
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "b", "leaf.txt"), "leaf");
  fs.writeFileSync(path.join(root, "top.txt"), "top");
}

async function main(): Promise<void> {
  const missing = path.join(dir, "missing");
  await settle("missing force", () => fsp.rm(missing, { recursive: true, force: true }));
  await settle("missing force only", () => fsp.rm(missing, { force: true }));
  await settle("missing", () => fsp.rm(missing, { recursive: true }));
  await settle("missing empty options", () => fsp.rm(missing, {}));

  const file = path.join(dir, "file.txt");
  fs.writeFileSync(file, "x");
  await settle("file", () => fsp.rm(file, { force: false }));
  console.log("file exists", fs.existsSync(file));

  const nested = path.join(dir, "nested");
  tree(nested);
  await settle("dir without recursive", () => fsp.rm(nested, { force: true }));
  console.log("dir exists", fs.existsSync(nested));
  await settle("dir recursive", () => fsp.rm(nested, { recursive: true }));
  console.log("dir exists", fs.existsSync(nested));
  tree(nested);
  await settle("fs.promises.rm", () => fs.promises.rm(nested, { recursive: true, force: true }));
  console.log("dir exists", fs.existsSync(nested));

  const retried = path.join(dir, "retried");
  tree(retried);
  await settle("retry", () => fsp.rm(retried, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }));
  console.log("retried exists", fs.existsSync(retried));
  await settle("retry missing", () => fsp.rm(retried, { maxRetries: 1 }));
  await settle("negative retries", () => fsp.rm(retried, { force: true, maxRetries: -1 }));
  await settle("fractional delay", () => fsp.rm(retried, { force: true, retryDelay: 1.5 }));

  await settle("null byte and range", () => fsp.rm("a\0b", { maxRetries: -1 }));
  await settle("too many retries", () => fsp.rm(retried, { force: true, maxRetries: 2 ** 32 }));
  await settle("long delay", () => fsp.rm(retried, { force: true, retryDelay: 2 ** 31 }));
  await settle("delay before retries", () => fsp.rm(retried, { maxRetries: -1, retryDelay: 0.5 }));

  tree(nested);
  attempt("rmSync dir", () => fs.rmSync(nested));
  attempt("rmSync dir force", () => fs.rmSync(nested, { force: true }));
  attempt("rmSync null byte and range", () => fs.rmSync("a\0b", { maxRetries: -1 }));
  attempt("rmSync negative delay", () => fs.rmSync(nested, { recursive: true, retryDelay: -1 }));
  attempt("rmSync retry", () => fs.rmSync(nested, { recursive: true, maxRetries: 1 }));
  console.log("dir exists", fs.existsSync(nested));

  // The promise is created before the await, and a rejection is caught
  // through .catch like any other promise.
  const pending = fsp.rm(missing, { recursive: false });
  await pending.catch((error: unknown) => report("caught", error));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("done", fs.existsSync(dir));
}

void main();
