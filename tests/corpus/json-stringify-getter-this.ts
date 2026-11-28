// Writes through a getter's `this` during JSON.stringify reach the object
// being serialized: a getter that deletes, rewrites or defines a later
// field sees the live object, not a copy, so the walker drops or writes
// what Node does. Plain object paths without accessors answer the same.
type Secret = { hook: string; secret?: string };

function deleting(): Secret | undefined {
  const value: Secret = {
    get hook(): string {
      delete (this as { secret?: string }).secret;
      return "got";
    },
    secret: "hunter2",
  };
  return value;
}
function assigning(): Secret | undefined {
  const value: Secret = {
    get hook(): string {
      this.secret = "changed";
      return "got";
    },
    secret: "hunter2",
  };
  return value;
}
function defining(): Secret | undefined {
  const value: Secret = {
    get hook(): string {
      Object.defineProperty(this, "extra", { value: 1, enumerable: true, configurable: true });
      return "got";
    },
    secret: "hunter2",
  };
  return value;
}
function directDelete(): Secret | undefined {
  const value: Secret = {
    get hook(): string {
      delete this.secret;
      return "got";
    },
    secret: "hunter2",
  };
  return value;
}

function out(label: string, f: () => unknown): void {
  const v = f();
  console.log(label, v === undefined ? "<undefined>" : String(v));
}
out("delete cast", () => JSON.stringify(deleting()));
out("delete direct", () => JSON.stringify(directDelete()));
out("assign", () => JSON.stringify(assigning()));
out("define", () => JSON.stringify(defining()));

const plain: { secret?: string } | undefined = { secret: "hunter2" };
delete plain!.secret;
out("plain delete", () => JSON.stringify(plain));
const plainAssign: { secret?: string } | undefined = { secret: "hunter2" };
plainAssign!.secret = "changed";
out("plain assign", () => JSON.stringify(plainAssign));

// A declared non-enumerable member stays hidden after it crosses the
// boundary, as an accessor and as a data property.
type Declared = { shown: string; hidden: string };
function hiddenMember(getter: boolean): unknown {
  const value: unknown = JSON.parse('{"shown":"a"}');
  Object.defineProperty(value, "hidden", getter
    ? { get() { return "secret"; }, enumerable: false, configurable: true }
    : { value: "secret", enumerable: false, configurable: true });
  return value;
}
const hiddenGetter = hiddenMember(true) as Declared;
out("hidden getter json", () => JSON.stringify(hiddenGetter));
out("hidden getter keys", () => Object.keys(hiddenGetter).join(","));
out("hidden getter read", () => hiddenGetter.hidden);
const hiddenData = hiddenMember(false) as Declared;
out("hidden data json", () => JSON.stringify(hiddenData));
out("hidden data keys", () => Object.keys(hiddenData).join(","));
out("hidden data read", () => hiddenData.hidden);
