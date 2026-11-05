// @requires-icu
// @env: LC_ALL=de_DE.UTF-8
// Number.prototype.toLocaleString() at the DEFAULT locale, which is the one
// form of the method that only ICU can answer (scr_intl.c over the vendored
// ICU archive): grouping, the decimal separator and the CLDR fraction-digit
// rules come from the locale's data, not from the engine-free en-US path
// that 2562-intl-numberformat-en-us.ts pins. The bare call and an explicit
// undefined are the same operation in EMCAScript; both lower here.
const xs = [0, 1, 100, 1000, 1234.5, 1234567.891, -9876543.21, 0.5, 1e6, 1e21];
for (const x of xs) console.log(x.toLocaleString());
console.log((1234.5).toLocaleString(undefined), (-0).toLocaleString());
console.log((0.0625).toLocaleString(), (1.0005).toLocaleString(), (7.995).toLocaleString());
console.log((NaN).toLocaleString(), (1 / 0).toLocaleString(), (-1 / 0).toLocaleString());
console.log((5e-4).toLocaleString(), (1e-7).toLocaleString(), (5e-324).toLocaleString());

// The result is an ordinary string: template interpolation, concatenation
// and methods all see the formatted text.
const label = `${(1234.5).toLocaleString()} Einheiten`;
console.log(label, label.length, (42).toLocaleString().padStart(8, "."));
const mapped = xs.map((x) => x.toLocaleString());
console.log(mapped.join("|"));

// An explicit undefined argument may carry effects and is evaluated.
let order = "";
function undef(value: string): undefined {
  order += value;
  return undefined;
}
console.log((1234.5).toLocaleString(undef("a")), order);

// The receiver is read before the argument runs: an argument that writes
// the receiver's variable does not change the number formatted.
let receiver = 1234.5;
function reassign(): undefined {
  receiver = 99;
  return undefined;
}
console.log(receiver.toLocaleString(reassign()), receiver.toLocaleString());

// The capability probe Node answers from its own ICU build: an Intl program
// links ICU, so the binary's answer is Node's (the number 1), and reading it
// is what links ICU.
console.log(process.config.variables.v8_enable_i18n_support);
