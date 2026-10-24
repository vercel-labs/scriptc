/* Node island tests need a libnode pack (SCRIPTC_LIBNODE). The Linux x64 CI
 * test lanes provide one (.github/actions/libnode-linux) and must run
 * these tests, so there a missing pack is a failure, never a skip. Other
 * CI platforms do not provision a pack yet, and a local run without a pack
 * skips. */
import { readFileSync } from "node:fs";

/** `// @requires-libnode` in a corpus program's two-line directive head. */
export function requiresLibnode(file: string): boolean {
  return readFileSync(file, "utf8")
    .split("\n", 2)
    .some((line) => /^\/\/ @requires-libnode\s*$/.test(line));
}

/** Whether CI must run the Node island tests on this machine. */
export const libnodeRequired =
  process.env["CI"] !== undefined &&
  process.env["CI"] !== "" &&
  process.env["CI"] !== "false" &&
  process.platform === "linux" &&
  process.arch === "x64";

/** The configured pack, or null. Throws where CI requires one. */
export function libnodePack(): string | null {
  const pack = process.env["SCRIPTC_LIBNODE"];
  if (pack !== undefined && pack !== "") return pack;
  if (libnodeRequired)
    throw new Error(
      "Node island tests need a libnode pack in this CI lane, and SCRIPTC_LIBNODE is not set (.github/actions/libnode-linux provides it)",
    );
  return null;
}
