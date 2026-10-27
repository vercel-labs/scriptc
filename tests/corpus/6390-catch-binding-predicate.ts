// A catch binding narrowed by a user type predicate reads its fields.
interface ErrorLike {
  message: string;
  name: string;
  code?: string;
}
function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null && "message" in value && "name" in value;
}
interface Coded {
  code: string;
}
function isCoded(value: unknown): value is Coded {
  return typeof value === "object" && value !== null && typeof (value as Coded).code === "string";
}
function report(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (isErrorLike(err)) {
      console.log("error", { message: err ? err.message : "none", name: err.name, code: err.code ?? "-" });
      if (err.message.includes("disk")) console.log("disk problem");
    } else {
      console.log("not error-like", String(err));
    }
    if (isCoded(err) && err.code === "ENOSPC") console.log("coded", err.code);
  }
}
report(() => {
  throw new Error("disk full");
});
report(() => {
  const e = new Error("no space") as Error & { code?: string };
  e.code = "ENOSPC";
  throw e;
});
report(() => {
  throw "plain";
});
report(() => {
  throw { message: "obj", name: "Custom", code: "ENOSPC" };
});
