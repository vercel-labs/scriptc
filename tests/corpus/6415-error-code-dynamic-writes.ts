// An Error's code written through a dynamic view (a `catch (e: any)`
// binding), copied onto an Error subclass with Object.assign, set to
// undefined, or deleted is what typed reads and `'code' in err` see, on
// Errors and on Error subclasses.
class CodedError extends Error {}

const original = new Error("a") as NodeJS.ErrnoException;
try {
  throw original;
} catch (e: any) {
  e.code = "E_ANY";
}
console.log("any write", original.code, "code" in original);

try {
  throw original;
} catch (e: any) {
  delete e.code;
}
console.log("any delete", original.code, "code" in original);

function codeOf(err: NodeJS.ErrnoException): string | undefined {
  return err.code;
}
const sub = new CodedError("b");
Object.assign(sub, { code: "E_ASSIGN" });
console.log("subclass assign", codeOf(sub), "code" in sub);

const plain = new Error("c") as NodeJS.ErrnoException;
Object.assign(plain, { code: "E_PLAIN" });
console.log("assign", plain.code, "code" in plain);

const cleared = new Error("d") as NodeJS.ErrnoException;
cleared.code = undefined;
console.log("undefined", cleared.code, "code" in cleared);
const fresh = new Error("e") as NodeJS.ErrnoException;
console.log("fresh", fresh.code, "code" in fresh);

const subCleared = new CodedError("f") as NodeJS.ErrnoException;
subCleared.code = undefined;
console.log("subclass undefined", subCleared.code, "code" in subCleared);
try {
  throw subCleared;
} catch (e: any) {
  console.log("subclass undefined through any", e.code, "code" in e);
}
subCleared.code = "E_SUB";
console.log("subclass string", subCleared.code, "code" in subCleared);
try {
  throw subCleared;
} catch (e: any) {
  e.code = undefined;
}
console.log("subclass any undefined", subCleared.code, "code" in subCleared);
try {
  throw subCleared;
} catch (e: any) {
  delete e.code;
}
console.log("subclass delete", subCleared.code, "code" in subCleared);

const subAssigned = new CodedError("g");
Object.assign(subAssigned, { code: undefined });
console.log("subclass assign undefined", codeOf(subAssigned), "code" in subAssigned);
