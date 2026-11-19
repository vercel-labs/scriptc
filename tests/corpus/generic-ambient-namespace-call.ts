// A GENERIC signature-only member of an ambient namespace: the declaration
// has no body to monomorphize and Node erases the namespace entirely, so the
// call is the catchable ReferenceError at the root read — the member and the
// arguments never evaluate.
declare namespace Missing {
  function make<T>(value: T): { value: T };
}

let evaluated = 0;
try {
  const held = Missing.make<number>(evaluated += 1);
  console.log("never", held.value);
} catch (e) {
  if (e instanceof Error) console.log("generic:", e.name + ": " + e.message);
}
console.log("arguments:", evaluated);

try {
  Missing.make<{ deep: number }>({ deep: (evaluated += 1) });
} catch (e) {
  if (e instanceof Error) console.log("record:", e.name + ": " + e.message);
}
console.log("arguments:", evaluated, "still running");
