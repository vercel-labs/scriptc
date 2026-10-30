import { $constructor } from "ctor-kit";

const Base = $constructor("Base", (inst: any, def: any) => {
  inst.kind = def.kind;
});
const Failure = $constructor(
  "Failure",
  (inst: any, def: any) => {
    inst.name = "Failure";
    inst.issues = def;
  },
  { Parent: Error },
);
const Coded = $constructor(
  "Coded",
  (inst: any, def: any) => {
    inst.code = def;
  },
  { Parent: TypeError },
);
const base = new Base({ kind: "plain" });
const failure = new Failure([1, 2]);
const coded = new Coded(7);
console.log(base.kind, base._zod.def.kind, base._zod.constr === Base);
console.log(failure.name, failure.issues.length, failure instanceof Error, failure._zod.constr === Failure);
console.log(coded.code, coded instanceof TypeError, coded instanceof Error, coded._zod.traits.has("Coded"));
