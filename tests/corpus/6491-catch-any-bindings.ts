// A catch binding annotated `any` reads the caught value through its
// checked-dynamic face: member reads, expando writes, `delete` and `in`
// act on the thrown object itself, and a rethrow keeps its identity.
const thrown: Error[] = [];

function fail(n: number): never {
  const e = new Error(`failure ${n}`);
  thrown.push(e);
  throw e;
}

for (const n of [1, 2]) {
  try {
    try {
      fail(n);
    } catch (error: any) {
      error.bail = n === 1;
      console.log("marked:", error.bail, "bail" in error, error.message);
      if (error.bail) {
        delete error.bail;
        console.log("deleted:", error.bail, "bail" in error);
      }
      throw error;
    }
  } catch (outer) {
    console.log("outer:", outer === thrown[n - 1], (outer as Error).message, "bail" in (outer as object));
  }
}

try {
  JSON.parse("{");
} catch (error: any) {
  console.log(error.name, typeof error.message, error instanceof SyntaxError);
}
