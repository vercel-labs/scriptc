// os.homedir(): $HOME whenever it is set — an empty value included — and
// the effective uid's passwd entry only when it is unset. The program
// mutates process.env between calls, which the compiled runtime sees through
// setenv(3)/unsetenv(3) exactly as Node does, so each line is a differential
// fact: the inherited value, a set value, the empty value, and the passwd
// fallback. On a host whose uid has no passwd entry the fallback throws, and
// the two sides compare the error fields instead (Node: SystemError
// ERR_SYSTEM_ERROR from uv_os_homedir).
import * as os from "node:os";

function report(label: string): void {
  try {
    console.log(label, JSON.stringify(os.homedir()));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.log(label, "threw", err.name, err.code, err.syscall, err.errno);
  }
}

report("inherited");

process.env.HOME = "/tmp/os-homedir-env-cascade";
report("set");

process.env.HOME = "";
report("empty");

delete process.env.HOME;
report("unset");

// A second call after the fallback answers the same thing: the lookup does
// not depend on anything the first call left behind.
report("unset-again");
