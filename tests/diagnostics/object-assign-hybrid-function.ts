// Object.assign onto a function VALUE, adding properties — the chalk
// `Object.assign(identity, { bold })` shape. JavaScript mutates the function
// object and answers it: the result IS that function, a write through either
// name lands on the one object, and Object.keys on the function lists the
// copied keys. scriptc keeps a function-with-properties value as a separate
// record (the function sits in its reserved %call field), so a fresh record
// is not the function and each of those answers would differ from Node. The
// refusal stands by name until a function object has one representation.
type Style = (s: string) => string;
const identity: Style = (s) => s;
const bold: Style = (s) => `[b]${s}[/b]`;
const blue = Object.assign(identity, { bold } as { bold: Style });
console.log(blue === identity);
const wrapped = Object.assign((s: string) => s, { bold } as { bold: Style });
console.log(wrapped("x"), wrapped.bold("x"));
