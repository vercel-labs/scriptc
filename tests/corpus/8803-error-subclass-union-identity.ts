// An instance of a program class that extends Error keeps its identity, its
// class and its fields when it becomes an untyped value from a union: a
// thrown union value, a union argument typed `unknown`, a union element,
// field or tuple slot read through `any`, a rejection reason, a cause. The
// `Error` check of that value answers the instance itself, not a new error
// rebuilt from its name and message.
class Fixed extends TypeError {
  status = 7;
}
class Plain extends Error {}
let fixed = new Fixed("x");
const plain = new Plain("p");
function pick(i: number): Plain | Fixed {
  fixed = new Fixed("x");
  return i > 0 ? fixed : plain;
}
function one(): Fixed {
  fixed = new Fixed("x");
  return fixed;
}
function check(label: string, u: unknown): void {
  if (u instanceof Error)
    console.log(
      label,
      u.name,
      u.message,
      u instanceof TypeError,
      u instanceof Fixed,
      u === fixed,
      u instanceof Fixed ? u.status : -1,
    );
  else console.log(label, "not an error", typeof u);
}

check("direct", one());
check("union", pick(1));
const maybe: Fixed | undefined = pick(1) instanceof Fixed ? fixed : undefined;
check("optional", maybe);
const mixed: Fixed | string = one().message.length > 0 ? fixed : "s";
check("or-string", mixed);
const rec: any = { err: one() };
check("record-field", rec.err);
const recUnion: any = { err: pick(1) };
check("record-union-field", recUnion.err);
const arr: any = [one()];
check("array-elem", arr[0]);
const arrUnion: any = [plain, pick(1)];
check("array-union-elem", arrUnion[1]);
const tuple: any = ["t", one()] as [string, Fixed];
check("tuple-elem", tuple[1]);
const map: any = new Map<string, Fixed>([["k", one()]]);
check("map-value", map.get("k"));
const mapUnion: any = new Map<string, Plain | Fixed>([["k", pick(1)]]);
check("map-union-value", mapUnion.get("k"));
const set: any = new Set<Plain | Fixed>([pick(1)]);
for (const member of set) check("set-member", member);
class Holder {
  err: Plain | Fixed = pick(1);
}
const holder: any = new Holder();
check("class-field-union", holder.err);
class HolderOne {
  own: Fixed = one();
}
const holderOne: any = new HolderOne();
check("class-field", holderOne.own);
const fn: any = () => pick(1);
check("closure-result", fn());
const fnOne: any = () => one();
check("closure-result-single", fnOne());
const recValues: any = { err: one() };
check("values", Object.values(recValues)[0]);
const recUnionValues: any = { err: pick(1) };
check("values-union", Object.values(recUnionValues)[0]);
const nested: any = { list: [{ err: pick(1) }] };
check("nested", nested.list[0].err);

// Thrown, rethrown and caught.
try {
  try {
    throw pick(1);
  } catch (inner) {
    throw inner;
  }
} catch (outer) {
  check("rethrow", outer);
}
try {
  try {
    throw pick(1);
  } finally {
    console.log("finally");
  }
} catch (outer) {
  check("finally", outer);
}
function thrower(): never {
  throw pick(1);
}
try {
  thrower();
} catch (caught) {
  check("function-throw", caught);
}
try {
  throw pick(1);
} catch (caught) {
  if (caught instanceof Fixed)
    console.log(
      "typed-narrow",
      caught.name,
      caught.status,
      caught === fixed,
      caught.stack === fixed.stack,
    );
  const view: any = caught;
  console.log(
    "any-view",
    view.name,
    view.message,
    view.status,
    view === fixed,
    Object.keys(view),
    Object.prototype.toString.call(view),
  );
  view.status = 9;
  console.log("write-through", fixed.status);
  view.message = "changed";
  console.log("message-through", fixed.message, String(fixed));
}
// A catch block that narrows to the builtin base of the thrown class.
try {
  throw pick(1);
} catch (caught) {
  if (caught instanceof TypeError) console.log("builtin-narrow", caught.name, caught === fixed);
}
function rethrowUnknown(value: unknown): never {
  throw value;
}
try {
  rethrowUnknown(one());
} catch (caught) {
  if (caught instanceof TypeError)
    console.log("builtin-narrow-unknown", caught.name, caught.message, caught === fixed);
}

async function main(): Promise<void> {
  const resolved: any = Promise.resolve(pick(1));
  check("resolved", await resolved);
  const typed = await Promise.resolve(pick(1));
  check("resolved-typed", typed);
  try {
    await Promise.reject(pick(1));
  } catch (caught) {
    check("rejected", caught);
  }
  try {
    await Promise.reject(one());
  } catch (caught) {
    check("rejected-single", caught);
  }
  const raced: unknown = await Promise.race([Promise.resolve(pick(1))]);
  check("race", raced);
  const outer = new Error("outer", { cause: pick(1) });
  check("cause", outer.cause);
  async function asyncThrower(): Promise<number> {
    throw pick(1);
  }
  try {
    await asyncThrower();
  } catch (caught) {
    check("async-throw", caught);
  }
  function* gen(): Generator<Plain | Fixed> {
    yield pick(1);
  }
  for (const value of gen()) check("generator", value);
  const settled = await Promise.allSettled([pick(1)].map((error) => Promise.reject(error)));
  for (const result of settled)
    if (result.status === "rejected") check("settled-rejected", result.reason);
  try {
    await Promise.any([pick(1)].map((error) => Promise.reject(error)));
  } catch (caught) {
    if (caught instanceof AggregateError) check("any", caught.errors[0]);
  }
  queueMicrotask(() => {
    try {
      throw pick(1);
    } catch (caught) {
      check("microtask", caught);
    }
  });
}
main();
