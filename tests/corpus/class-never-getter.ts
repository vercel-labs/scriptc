// A getter that never returns a value compiles: annotated `never` or
// unannotated (the removed-API getter idiom, which throws), and a getter
// without a return statement, whose reads answer undefined.
class Req {
  ok = 1;
  get page(): never {
    throw new Error("page has been removed");
  }
  get ua(): never {
    throw new TypeError("ua has been removed");
  }
  public get legacy() {
    throw new RangeError("legacy has been removed");
  }
  get nothing() {
    return;
  }
}
const r = new Req();
try {
  console.log(r.page);
} catch (e) {
  console.log(e instanceof Error ? `${e.name}: ${e.message}` : e);
}
try {
  const ua = r.ua;
  console.log("unreachable", ua);
} catch (e) {
  console.log(e instanceof Error ? `${e.name}: ${e.message}` : e);
}
try {
  console.log(r.legacy);
} catch (e) {
  console.log(e instanceof Error ? `${e.name}: ${e.message}` : e);
}
console.log(r.ok, r.nothing);
