// An annotated `.catch` parameter — `.catch((error: Error) => ...)`. The
// annotation is a claim the checker cannot verify (the reject payload is
// whatever was thrown), so the handler's parameter binds as the typed-catch
// snapshot exactly like `catch (e)`, and every read is a checked
// extraction: an `Error` payload extracts and reads normally, while any
// other payload raises the catchable TypeError at the read instead of
// reading through it. Every payload below is what the annotation claims,
// so Node and the native build agree byte for byte.
async function fail(kind: number): Promise<number> {
  if (kind === 0) throw new Error("boom");
  if (kind === 1) throw new TypeError("bad type");
  return 7;
}

async function main(): Promise<void> {
  const a = await fail(0).catch((error: Error) => {
    console.log("caught", error instanceof Error, error.name, error.message);
    return -1;
  });
  console.log("a", a);

  const b = await fail(1).catch((error: TypeError) => {
    console.log("typed", error.name, error.message);
    return -2;
  });
  console.log("b", b);

  // No rejection: the handler never runs.
  const ok = await fail(2).catch((error: Error) => {
    console.log("never");
    return -3;
  });
  console.log("ok", ok);

  // A property read of the annotated parameter, and a handler that
  // deliberately narrows a second time.
  const len = await fail(0).catch((error: Error) => {
    if (error instanceof TypeError) {
      return 0;
    }
    return error.message.length;
  });
  console.log("len", len);

  // A rethrow from an annotated handler, caught by an outer `.catch`.
  await fail(0)
    .catch((error: Error) => {
      throw new RangeError(`wrapped ${error.message}`);
    })
    .catch((outer: RangeError) => {
      console.log("outer", outer.name, outer.message);
      return 0;
    });

  // The same handler shape on an explicitly typed promise, through `await`
  // and through a second `.then` on the result.
  const p: Promise<string> = Promise.reject(new Error("explicit"));
  const recovery = p.catch((error: Error): string => `recovered: ${error.message}`);
  console.log(await recovery);

  // A handler whose parameter is annotated and whose body reads the error
  // twice (each read is the same checked extraction).
  await fail(1)
    .catch((error: TypeError) => {
      console.log("twice", error.message, error.message);
      return 0;
    })
    .then((v) => console.log("then", v));

  // A void handler (the result keeps the undefined arm) and a rethrow of
  // the annotated parameter itself.
  const voided = await fail(0).catch((error: Error) => {
    console.log("void handler", error.message);
  });
  console.log("voided", voided);
  try {
    await fail(0).catch((error: Error) => {
      throw error;
    });
  } catch (e) {
    console.log("rethrown", e instanceof Error);
  }

  // A bare-expression annotated handler returning a string.
  console.log(await fail(0).catch((error: Error): string => `${error.name}: ${error.message}`));

  // A class outside the Error hierarchy, with no base and no subclass: the
  // handler receives the thrown instance itself.
  const code = await throwPlain().catch((p: Plain) => {
    console.log("plain", p.code, p === plain, p instanceof Plain);
    return p.code;
  });
  console.log("plain code", code);
}

class Plain {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}
const plain = new Plain(7);
async function throwPlain(): Promise<number> {
  throw plain;
}

main();
