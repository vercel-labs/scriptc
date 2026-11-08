// The typed spellings of the same calls: `process.disconnect()` as a
// statement, the asserted `process.disconnect!()` and the optional
// `process.disconnect?.()`.
const attempt = (label: string, go: () => void): void => {
  try {
    go();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, "threw", error instanceof TypeError, (error as Error).message);
  }
};
attempt("disconnect", () => {
  process.disconnect();
});
attempt("disconnect!", () => {
  process.disconnect!();
});
attempt("disconnect?.", () => {
  process.disconnect?.();
});
attempt("send!", () => {
  process.send!({ a: 1 });
});
attempt("concise", () => process.disconnect());
console.log("after");
