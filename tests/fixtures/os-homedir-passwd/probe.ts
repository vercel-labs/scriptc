// os.homedir() and os.userInfo() when the effective uid has no passwd
// entry and HOME is unset: both throw Node's SystemError, and the program
// keeps running. The fields the two sides print are compared line for line
// by tests/harness/os-homedir-passwd.test.ts.
import * as os from "node:os";

function show(label: string, read: () => unknown): void {
  try {
    console.log(label, "ok", JSON.stringify(read()));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { info?: Record<string, unknown> };
    const info = err.info;
    console.log(
      label,
      "threw",
      err.name,
      JSON.stringify(err.message),
      err.code,
      err.errno,
      err.syscall,
      info?.errno,
      info?.code,
      JSON.stringify(info?.message),
      info?.syscall,
      info?.path,
      info?.dest,
    );
  }
}

show("homedir", () => os.homedir());
show("userInfo", () => os.userInfo().username);
