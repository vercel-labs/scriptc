// The execFile and exec callback forms bind no option values, so a
// Windows-only member whose value has to be evaluated (a call) has no place
// to run there and is refused by name instead of being dropped.
import { exec, execFile } from "node:child_process";

function hidden(): boolean {
  return true;
}

execFile("/bin/echo", [], { encoding: "utf8", windowsHide: hidden() }, () => {});
exec("echo", { windowsHide: hidden() }, () => {});
