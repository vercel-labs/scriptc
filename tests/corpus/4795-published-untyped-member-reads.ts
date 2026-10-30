import { publish } from "@scriptc/threads";

// Reading members of a published (deep-frozen) class instance through an
// untyped value must not write to it. Node.js reads methods, `constructor`
// and absent properties of a frozen object without error. scriptc keeps own
// dynamic properties in a lazily created bag; selecting a method checks that
// bag for an own property shadowing it, and that check must not create the
// bag on an object that can no longer change.

interface Host {
  readonly cwd: string;
  root(): string;
}

class Program implements Host {
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  root(): string {
    return this.cwd + "/src/";
  }
}

class Fallback implements Host {
  readonly cwd = "";
  root(): string {
    return "";
  }
}

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(`${label}: ${String(f())}`);
  } catch (e) {
    console.log(`${label}: ${e instanceof TypeError ? "TypeError" : "other"}: ${(e as Error).message}`);
  }
}

function untyped(host: Host): any {
  return host;
}

// An own dynamic property on another instance gives the class its bag.
const scratch: any = new Program("/scratch");
scratch.root = () => "shadowed";
attempt("own property shadows the method", () => scratch.root());

const program = publish(new Program("/work"));
const host = untyped(program);
attempt("published method read", () => host.root());
attempt("published field read", () => host.cwd);
attempt("published constructor read", () => host.constructor === Program);
attempt("published in-check", () => "root" in host);
attempt("published absent read", () => host.missing);
attempt("published computed read", () => host["cw" + "d"]);
attempt("published typed call", () => program.root());
const selected = program.root;
attempt("published typed value", () => selected.call(program));

class Empty {
  root(): string { return "empty"; }
}
const empty = publish(new Empty());
attempt("published fieldless call", () => empty.root());
const emptyRoot = empty.root;
attempt("published fieldless value", () => emptyRoot.call(empty));

function local(label: string): void {
  class Local {
    root(): string { return label; }
  }
  // Local TS prototype reflection is separate; own callbacks keep their captures.
  const value = new Local();
  value.root = () => label;
  Object.freeze(value);
  attempt("frozen local call", () => value.root());
  const root = value.root;
  attempt("frozen local value", () => root.call(value));
}
local("local");

const redirected = new Program("/redirected");
let assigned = "";
Object.setPrototypeOf(redirected, {
  set root(value: () => string) { assigned = value(); },
});
redirected.root = () => "setter";
console.log("typed setter", assigned, Object.hasOwn(redirected, "root"));
Object.freeze(redirected);
redirected.root = () => "frozen setter";
console.log("frozen typed setter", assigned, Object.hasOwn(redirected, "root"));

const hosts: Host[] = [program, new Fallback(), new Program("/other")];
for (const h of hosts) attempt(`interface read ${h.constructor.name}`, () => untyped(h).root() + "|" + untyped(h).cwd);
