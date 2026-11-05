// A `typeof e === "object" && "code" in e` test narrows a catch binding to
// the structural shape the assertion names. The binding still holds whatever
// was thrown, so the assertion reads it through the checked-dynamic bridge:
// an object payload reads its own property (Node's read), and the surrounding
// `String(...)` converts the value Node would convert.
function report(label: string, payload: unknown): void {
  try {
    throw payload;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    console.log(`${label}:${code === undefined ? "none" : code}`);
  }
}

report("number-code", { code: 42 });
report("string-code", { code: "E7" });
report("undefined-code", { code: undefined });
report("no-code", { other: 1 });
report("string-payload", "plain");
report("null-payload", null);
report("number-payload", 5);
report("error-payload", Object.assign(new Error("boom"), { code: "E9" }));
