// os.setPriority([pid, ]priority): the one-argument form sets the current
// process, both arguments go through validateInt32 (the priority within
// -20..19, a RangeError with code ERR_OUT_OF_RANGE otherwise), and a
// refused change is a SystemError with code ERR_SYSTEM_ERROR naming
// uv_os_setpriority. Raising the nice value is always allowed; lowering it
// again depends on the privileges of the user running the program.
import * as os from "node:os";
import { getPriority, setPriority } from "node:os";

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "ok", getPriority());
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, e.name, e.code, e.message);
  }
}

const start = getPriority();
attempt("same value", () => setPriority(start));
attempt("same value with pid 0", () => os.setPriority(0, start));
attempt("same value with own pid", () => setPriority(process.pid, start));
attempt("raise", () => setPriority(Math.min(start + 5, 19)));
console.log("raised by 5 or to 19:", getPriority() === Math.min(start + 5, 19));
attempt("lower again", () => setPriority(start));
attempt("priority 20", () => setPriority(20));
attempt("priority -21", () => setPriority(0, -21));
attempt("priority 1.5", () => setPriority(1.5));
attempt("priority NaN", () => setPriority(Number.NaN));
attempt("pid 2 ** 31", () => setPriority(2 ** 31, 0));
attempt("pid -1.5", () => setPriority(-1.5, 0));
attempt("missing process", () => setPriority(2147483646, 19));
