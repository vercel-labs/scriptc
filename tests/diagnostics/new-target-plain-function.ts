// new.target in a plain function has no invocation record to read.
function F(this: unknown) { console.log(new.target === undefined); }
F.call(null);
