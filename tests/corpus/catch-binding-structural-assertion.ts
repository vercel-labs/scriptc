// `(error as { code?: unknown })` over a catch binding the checker narrowed
// with `"code" in error`: the assertion crosses into the checked-dynamic
// value and the member read validates its own result, exactly what Node does
// with the same thrown payload — no rethrow, no duck-typed class needed.
function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    return code;
  }
}

console.log(codeOf(() => {
  throw Object.assign(new Error("locked"), { code: "ELOCKED" });
}));
console.log(codeOf(() => {
  throw { code: 3 };
}));
console.log(codeOf(() => {
  throw { code: null };
}));
console.log(codeOf(() => {
  throw { code: undefined };
}));
console.log(codeOf(() => {
  throw new Error("plain");
}));
console.log(codeOf(() => {
  throw "text";
}));
console.log(codeOf(() => {
  throw null;
}));
console.log(codeOf(() => {
  throw 7;
}));

// The same assertion chain classifies a retry decision, the loop shape the
// callers actually use.
function attemptsOf(fn: () => void, max: number): number {
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      fn();
      return attempt;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code !== "ELOCKED" || attempt === max) throw error;
    }
  }
  return 0;
}

let calls = 0;
const settlesAt = attemptsOf(
  () => {
    calls++;
    if (calls < 2) throw Object.assign(new Error("busy"), { code: "ELOCKED" });
  },
  5,
);
console.log("settles at", settlesAt, "after", calls, "calls");

calls = 0;
try {
  attemptsOf(
    () => {
      calls++;
      throw Object.assign(new Error("busy"), { code: "ELOCKED" });
    },
    3,
  );
  console.log("no rethrow");
} catch (error) {
  if (error instanceof Error) console.log("rethrown", error.message, "after", calls, "calls");
}

try {
  attemptsOf(
    () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    3,
  );
  console.log("no rethrow");
} catch (error) {
  if (error instanceof Error) console.log("other code", error.message);
}
