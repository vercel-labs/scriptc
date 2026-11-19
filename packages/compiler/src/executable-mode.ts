import { chmodSync, statSync } from "node:fs";

/** The mode a spawnable toolchain payload carries. */
const EXECUTABLE_MODE = 0o755;

interface ExecutableModeIo {
  statSync(path: string): { mode: number };
  chmodSync(path: string, mode: number): void;
}

const defaultIo: ExecutableModeIo = { statSync, chmodSync };

/** Makes sure a toolchain payload (the ts7 checker, tsc-ts, the LLVM
 * helper or the compile-time evaluator) can be executed before it is
 * spawned. A package manager that installs from a cache, or with lifecycle
 * scripts disabled, can leave the payload at mode 0644 and the postinstall
 * never repairs it; spawning it then fails with EACCES ("Permission
 * denied"). Repair the mode when the file is writable, and otherwise name
 * the file and the fix so the failure is actionable. Windows has no
 * execute bit. */
export function ensureExecutable(path: string, io: ExecutableModeIo = defaultIo): void {
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = io.statSync(path).mode;
  } catch (error) {
    throw new Error(
      `toolchain executable ${path} is missing; reinstall scriptc (${(error as Error).message})`,
    );
  }
  if ((mode & 0o111) !== 0) return;
  try {
    io.chmodSync(path, EXECUTABLE_MODE);
    return;
  } catch {
    /* Not writable: report below. */
  }
  const printed = (mode & 0o777).toString(8).padStart(3, "0");
  throw new Error(
    `toolchain executable ${path} is not executable (mode ${printed}) and could not be repaired; ` +
      `fix it with: chmod +x "${path}"`,
  );
}
