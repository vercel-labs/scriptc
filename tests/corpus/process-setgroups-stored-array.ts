// process.setgroups takes an Array. A stored TypeScript array crosses the
// untyped argument slot as a typed-reference capsule, and the runtime must
// see the array it names: the Array test passes, the elements validate, and
// a failing lookup names its index — the same answer an inline literal
// gets. A non-array value (a class instance) still fails the Array test.
// Every lookup fails before the syscall, so no privileges are needed.
function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const refused = error as { name: string; code: string };
    console.log(label, "|", refused.name, refused.code);
  }
}

const gid = process.getgid!();
const unknown: string[] = ["scriptc-no-such-group"];
attempt("stored-unknown", () => process.setgroups!(unknown));

const second: (string | number)[] = [gid, "scriptc-no-such-group"];
attempt("stored-unknown-second", () => process.setgroups!(second));

class Bag {
  0 = gid;
  length = 1;
}
attempt("instance", () => process.setgroups!(new Bag() as unknown as string[]));

const notArray: string = "scriptc-no-such-group";
attempt("string", () => process.setgroups!(notArray as unknown as string[]));
