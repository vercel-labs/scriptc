export {};
// The result idiom `({ ok: true } & T) | { ok: false; error: E }`: inside the
// generic body the arm keeps the symbolic intersection with the bound
// parameter, so the instantiated arm merges the record parts per
// instantiation. Covers a value, several members, a nested record, the
// empty-object binding (which contributes nothing) and the failure arm.
type Result<T, E = string> = ({ ok: true } & T) | { ok: false; error: E };

function succeed<T, E = string>(value: T): Result<T, E> {
  return { ok: true, ...value };
}

function fail<E = string>(error: E): Result<Record<string, never>, E> {
  return { ok: false, error };
}

const wrote = succeed({ nwritten: 3 });
if (wrote.ok) console.log("wrote", wrote.nwritten);

const named = succeed({ name: "x", count: 2 });
if (named.ok) console.log("named", named.name, named.count);

const nested = succeed({ inner: { a: 1 } });
if (nested.ok) console.log("nested", nested.inner.a);

const blank = succeed({});
if (blank.ok) console.log("blank", Object.keys(blank).length);

const none = fail("bad");
if (!none.ok) console.log("failed", none.error);
