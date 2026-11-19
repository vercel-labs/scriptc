// fs.promises.lchmod from a typed program, both spellings: the promise exists
// on every platform and rejects with Node's ERR_METHOD_NOT_IMPLEMENTED where
// lchmod(2) does not exist.
import { lchmod } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-lchmod-typed-"));
const file = join(dir, "data.bin");
fs.writeFileSync(file, "data");
try {
  await lchmod(file, 0o600);
  console.log("lchmod", "ok");
} catch (err) {
  console.log(
    "lchmod",
    (err as Error).name,
    (err as { code?: string }).code,
    (err as Error).message,
  );
}
try {
  await fs.promises.lchmod(file, 0o644);
  console.log("promises.lchmod", "ok");
} catch (err) {
  console.log("promises.lchmod", (err as Error).name, (err as { code?: string }).code);
}
fs.rmSync(dir, { recursive: true, force: true });
