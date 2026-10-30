import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "node-types-url-"));
const file = pathToFileURL(join(dir, "a.txt"));
writeFileSync(file, "hi");
// existsSync answers false for a URL it cannot convert.
console.log(existsSync(file), existsSync(new URL("http://example.com/")));
// fs.promises functions reject for a URL they cannot convert.
readFile(file, "utf8")
  .then((text) => console.log(text))
  .then(() => readFile(new URL("file://example.com/a.txt"), "utf8"))
  .catch((error: unknown) => {
    if (error instanceof Error) console.log((error as NodeJS.ErrnoException).code);
    rmSync(dir, { recursive: true });
  });
