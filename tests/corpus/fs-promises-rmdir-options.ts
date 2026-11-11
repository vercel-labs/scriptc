// @normalize-pid
// fs.promises.rmdir's options record: validateRmdirOptions' defaults, the
// path checked before the options, an own key whose value is undefined
// replacing a default, the validation ladders of recursive, retryDelay and
// maxRetries, the DEP0147 report the recursive form prints once per process,
// the stat that separates the retry walk from plain rmdir, and the error
// shapes of both.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fsp-rmdir-"));
const empty = join(dir, "empty");
const nested = join(dir, "nested");
const file = join(dir, "file.txt");
const missing = join(dir, "missing");
mkdirSync(empty);
mkdirSync(join(nested, "deep"), { recursive: true });
writeFileSync(join(nested, "deep", "leaf.txt"), "leaf");
writeFileSync(file, "x");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

async function settle(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (error) {
    if (error instanceof Error) {
      const errno = error as NodeJS.ErrnoException;
      console.log(
        label,
        error.name,
        JSON.stringify(errno.code),
        JSON.stringify(errno.syscall),
        JSON.stringify(clean(error.message)),
      );
    } else {
      console.log(label, "non-error");
    }
  }
}

// The record's ladders, in validateRmdirOptions' order. Every value is
// checked against an existing empty directory, so only the record can
// decide the outcome.
const record = (value: any): any => value;
await settle("recursive 1", () => rmdir(empty, record({ recursive: 1 })));
await settle("recursive undefined", () => rmdir(empty, record({ recursive: undefined })));
await settle("recursive null", () => rmdir(empty, record({ recursive: null })));
await settle("retryDelay 1.5", () => rmdir(empty, record({ retryDelay: 1.5 })));
await settle("retryDelay -1", () => rmdir(empty, record({ retryDelay: -1 })));
await settle("retryDelay high", () => rmdir(empty, record({ retryDelay: 2147483648 })));
await settle("retryDelay string", () => rmdir(empty, record({ retryDelay: "1" })));
await settle("retryDelay undefined", () => rmdir(empty, record({ retryDelay: undefined })));
await settle("maxRetries -1", () => rmdir(empty, record({ maxRetries: -1 })));
await settle("maxRetries 1.5", () => rmdir(empty, record({ maxRetries: 1.5 })));
await settle("maxRetries high", () => rmdir(empty, record({ maxRetries: 4294967296 })));
await settle("maxRetries undefined", () => rmdir(empty, record({ maxRetries: undefined })));
await settle("options null", () => rmdir(empty, record(null)));
await settle("options true", () => rmdir(empty, record(true)));
await settle("options string", () => rmdir(empty, record("recursive")));
await settle("options function", () => rmdir(empty, record(() => undefined)));
console.log("empty survives validation", existsSync(empty));

// validateObject accepts a non-plain object, and the defaults spread over
// its own enumerable keys: a class instance's field is read like a
// literal's.
class Plain {
  recursive = false;
}
await settle("options instance", () => rmdir(empty, record(new Plain())));
console.log("empty removed", !existsSync(empty));

// An absent record is the whole default set: a plain rmdir.
mkdirSync(empty);
await settle("options undefined", () => rmdir(empty, record(undefined)));
console.log("defaults removed", !existsSync(empty));

// The path is checked before the record — here a NUL byte in it.
await settle("nul path", () => rmdir(`${dir}\0x`, record({ recursive: 1 })));

// The syscall shapes: a missing path stats as "stat" in the recursive form
// and rmdirs as "rmdir" without it; a file is ENOTDIR both ways.
await settle("missing", () => rmdir(missing));
await settle("missing recursive", () => rmdir(missing, { recursive: true }));
await settle("file", () => rmdir(file));
await settle("file recursive", () => rmdir(file, { recursive: true }));
console.log("file survives", existsSync(file));

mkdirSync(empty);
await settle("non-empty", () => rmdir(nested));
console.log("nested survives", existsSync(nested));
await settle("non-empty record", () => rmdir(nested, { retryDelay: 1, maxRetries: 1 }));
await settle("recursive", () => rmdir(nested, { recursive: true, retryDelay: 1, maxRetries: 2 }));
console.log("nested removed", !existsSync(nested));
await settle("recursive retryDelay 0", () => rmdir(empty, { recursive: true, retryDelay: 0 }));
console.log("empty removed again", !existsSync(empty));

rmSync(dir, { recursive: true, force: true });
console.log("done", !existsSync(dir));
