// @normalize-pid
// execFileSync's shell option read at call time: undefined takes the direct
// launch, a boolean binding that holds true goes through /bin/sh -c, and the
// joined command reports DEP0190 once, exactly as Node does.

import { execFileSync } from "node:child_process";

const maybeShell: boolean | undefined =
  process.env["SC_TEST_SHELL"] === "1" ? true : undefined;
const direct = execFileSync("echo", ["direct ok"], { shell: maybeShell, encoding: "utf8" });
console.log(JSON.stringify(direct));

const useShell: boolean = true;
const shelled = execFileSync("echo", ["shell ok"], { shell: useShell, encoding: "utf8" });
console.log(JSON.stringify(shelled));

const anyShell: any = true;
const viaAny = execFileSync("echo", ["dyn ok"], { shell: anyShell, encoding: "utf8" });
console.log(JSON.stringify(viaAny));

const anyOff: any = undefined;
const offAny = execFileSync("echo", ["dyn off"], { shell: anyOff, encoding: "utf8" });
console.log(JSON.stringify(offAny));

const anyPath: any = "/bin/sh";
const path = execFileSync("echo", ["dyn path"], { shell: anyPath, encoding: "utf8" });
console.log(JSON.stringify(path));
