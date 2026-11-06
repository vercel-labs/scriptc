// A `.catch((error: Error) => …)` handler's typed parameter annotates the
// payload the handler EXPECTS; the rejection carries whatever was thrown.
// The binding lowers as the catch binding, so every read is the checked
// extraction for the annotation (an `instanceof` test that keeps a native
// Error payload and refuses any other with a catchable TypeError) rather
// than an unchecked read through the annotation's layout.
async function main(): Promise<void> {
  const attempt = (label: string, p: Promise<number>): Promise<void> =>
    p
      .then((value) => console.log(`${label}:ok:${value}`))
      .catch((error: Error) => console.log(`${label}:caught:${error.name}:${error.message}`));

  await attempt("resolved", Promise.resolve(7));
  await attempt("rejected", Promise.reject(new TypeError("bad input")));
  await attempt("coded", Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })));

  // The handler still returns the promise's own value type through the
  // typed parameter (a literal in a block body, and a bare expression).
  const failing: Promise<number> = Promise.reject(new Error("one"));
  const one = await failing.catch((error: Error): number => {
    return error.message.length;
  });
  console.log(`length:${one}`);
  const two = await Promise.resolve(2).catch((error: Error) => error.message.length);
  console.log(`untouched:${two}`);
}

void main();
