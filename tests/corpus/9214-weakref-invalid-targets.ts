// Only objects, arrays and non-registered symbols can be weakly held. A
// primitive or a registered symbol is not a target, and Node throws one
// TypeError for each.
const invalid: unknown[] = [undefined, null, true, 1, "text", Symbol.for("scriptc")];
for (const value of invalid) {
  try {
    new WeakRef(value as object);
    console.log("no throw");
  } catch (error) {
    const e = error as Error;
    console.log(e.name, e.message);
  }
}
console.log("targets checked", invalid.length);
