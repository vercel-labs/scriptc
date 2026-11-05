// A presence probe through an assertion answers off the value actually
// stored: a setter-only arm reads undefined, a getter arm calls its getter,
// and neither traps in the assertion's checked extraction.
const side: string[] = [];
const setterArm = {
  tag: "s" as const,
  set stream(_v: () => string) {
    side.push("setter");
  },
};
const dataArm = { tag: "d" as const, stream: () => "d" };
function pickSet(which: "s" | "d"): typeof setterArm | typeof dataArm {
  return which === "s" ? setterArm : dataArm;
}
for (const which of ["s", "d"] as const) {
  const stored = pickSet(which);
  try {
    console.log("setter", which, typeof (stored as typeof dataArm).stream);
  } catch (err) {
    console.log("setter", which, "threw", err instanceof TypeError ? "TypeError" : "other");
  }
}
console.log("setter side", side.join(","));

const reads: string[] = [];
const getterOnly = {
  tag: "g" as const,
  get stream(): () => string {
    reads.push("getter");
    return () => "g";
  },
};
const absentArm = { tag: "a" as const, other: 1 };
function pickOnly(which: "g" | "a"): typeof getterOnly | typeof absentArm {
  return which === "g" ? getterOnly : absentArm;
}
for (const which of ["g", "a"] as const) {
  const stored = pickOnly(which);
  try {
    console.log("only", which, typeof (stored as typeof getterOnly).stream);
  } catch (err) {
    console.log("only", which, "threw", err instanceof TypeError ? "TypeError" : "other");
  }
}
console.log("only reads", reads.join(","));
