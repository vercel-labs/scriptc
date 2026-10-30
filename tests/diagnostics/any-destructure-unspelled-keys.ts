// Destructuring an `any` source keeps SC1031 where the source has no
// compiled spelling for V8's TypeError: a key computed by an expression, an
// optional element read, a template key with a substitution, and a string key
// holding NUL (the message is a C string). String-literal keys compile
// (tests/corpus/7310-any-destructure-string-keys.ts).
const events: any = { ab: { value: 1 } };
const k = "a";
const { value: computed } = events["a" + "b"];
const { value: optional } = events?.["ab"];
const { value: template } = events[`${k}b`];
const { value: nul } = events["a\0b"];
console.log(computed, optional, template, nul);
