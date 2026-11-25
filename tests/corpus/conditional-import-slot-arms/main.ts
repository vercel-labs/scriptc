// A conditional `import()` of two modules settles ONE of two namespace
// objects, used IN PLACE (`??=`, a `.then` on the conditional itself). The
// checker types the conditional by one arm — a union of module namespaces
// does not serialize back — so the lowering joins the arms it actually
// lowered, several namespace payloads become one checked-dynamic payload,
// and a `then` handler the checker typed as a namespace reads that
// namespace OBJECT's exports.
type CreateX = () => string;

let cached: Promise<CreateX> | undefined;

function getCreateX(flag: boolean): Promise<CreateX> {
  cached ??= (flag ? import("./left.ts") : import("./right.ts")).then((module) => module.createX);
  return cached;
}

getCreateX(false).then((createX) => console.log("called", createX()));
// The deferred-init slot holds the first promise: one module evaluated, one
// answer, exactly like Node.
getCreateX(true).then((createX) => console.log("cached", createX()));

// `await` of the same conditional is a separate shape: the awaited value is
// the settled namespace, which the checker types as one module's namespace —
// that needs the declaration to take the dyn value, not just the handler.
