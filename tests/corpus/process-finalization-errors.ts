// @normalize-pid
// Node validates the reference at the call (an object other than an array;
// functions pass) and validates nothing about the callback: a non-function
// is accepted, then called at exit, where the uncaught TypeError ends the
// process 1. That trace names Node's internal frames, so the invalid
// callback runs in a child and the parent compares the status and the
// error line only.
import { spawnSync } from "node:child_process";

type Attempt = (label: string, fn: () => void) => void;
const attempt: Attempt = (label, fn) => {
  try {
    fn();
    console.log(`${label}: ok`);
  } catch (err) {
    const e = err as { name: string; code?: string; message: string };
    console.log(`${label}: ${e.name} ${e.code ?? "-"} ${e.message}`);
  }
};

if (process.argv[2] === "bad-callback") {
  process.finalization.register({ ok: 1 }, 1 as unknown as () => void);
  console.log("child end");
} else {
  const kept = { kept: true };
  process.finalization.register(kept, () => console.log("kept exit"));

  attempt("null ref", () => process.finalization.register(null as unknown as object, () => {}));
  attempt("undefined ref", () =>
    process.finalization.register(undefined as unknown as object, () => {}),
  );
  attempt("number ref", () => process.finalization.register(1 as unknown as object, () => {}));
  attempt("string ref", () => process.finalization.register("s" as unknown as object, () => {}));
  attempt("array ref", () => process.finalization.register([] as unknown as object, () => {}));
  attempt("fn ref", () => process.finalization.register((() => {}) as unknown as object, () => {}));
  attempt("beforeExit null", () =>
    process.finalization.registerBeforeExit(null as unknown as object, () => {}),
  );

  attempt("unregister null", () => process.finalization.unregister(null as unknown as object));
  attempt("unregister number", () => process.finalization.unregister(1 as unknown as object));
  attempt("unregister string", () => process.finalization.unregister("s" as unknown as object));
  attempt("unregister symbol", () => process.finalization.unregister(Symbol("t") as unknown as object));
  attempt("unregister array", () => process.finalization.unregister([] as unknown as object));
  attempt("unregister kept", () => process.finalization.unregister(kept));
  console.log("after unregister kept:", process.finalization.unregister(kept));

  const child = spawnSync(process.execPath, [process.argv[1], "bad-callback"], {
    encoding: "utf8",
  });
  console.log("bad callback child:", child.status, child.stdout.trim());
  console.log("bad callback throws:", /TypeError: fn is not a function/.test(child.stderr));
}
