// `f?.(…)` where the checker types the callee never-nullish: an imported
// node:fs function has no value form at all (only a call), and the guard
// can never short-circuit, so the step is the plain call. The present
// target is created and removed; the force-missing target stays silent,
// exactly as the plain call.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "scriptc-optcall-"));
const dir = join(base, "nested");

rmSync?.(dir, { force: true, recursive: true });
mkdirSync(dir, { recursive: true });
console.log("created");

rmSync?.(dir, { force: true, recursive: true });
console.log("removed");

rmSync?.(join(base, "missing"), { force: true, recursive: true });
console.log("missing ok");

// The plain spelling of the same import keeps compiling unchanged.
rmSync(dir, { force: true, recursive: true });
console.log("plain ok");

rmSync?.(base, { force: true, recursive: true });
