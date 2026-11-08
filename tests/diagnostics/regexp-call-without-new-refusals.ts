// `RegExp(pattern)` without `new` returns a RegExp pattern itself (when its
// constructor is RegExp and the flags are undefined) rather than a copy, so
// a pattern that may be a RegExp refuses unless flags that cannot be
// undefined come with it (tests/corpus/regexp-call-without-new.cjs).
const source = /ab+c/i;
const same = RegExp(source);

const input = process.argv.length > 99 ? "x" : source;
const either = RegExp(input);

const flags = process.argv.length > 99 ? "g" : undefined;
const maybeFlags = RegExp(source, flags);

console.log(same.source, either.source, maybeFlags.source);
