console.log(Number(null), Number(undefined), Number(void 0));

const nil = null;
const missing = undefined;
console.log(Number(nil), Number(missing));

let effects = "";
function value() { effects += "v"; return 7; }
function nullValue() { effects += "n"; return null; }
function undefinedValue() { effects += "u"; return undefined; }
console.log(Number(void value()), effects);
console.log(Number(nullValue()), Number(undefinedValue()), effects);
