// Discarded conditionals whose arms produce no value: JS evaluates only the
// selected arm and drops the result. The arms here end in void calls, and one
// arm's untyped `value && (...)` makes the checker spell the whole
// conditional `any`, so the value form would build a void ternary the IR
// cannot hold; the statement lowers as the branch it is instead.
function setProp(tag, key, value) {
  null != value &&
    ("form" === tag
      ? "formAction" === key
        ? console.error("a")
        : "function" === typeof value && (console.error("b"), console.error("c"))
      : "input" === tag || "button" === tag
        ? "action" === key
          ? console.error("d")
          : console.error("e")
        : "action" === key
          ? console.error("f")
          : console.error("g"));
}
setProp("input", "formAction", () => {});
setProp("form", "formAction", () => {});
setProp("div", "action", 1);

// A discarded nested conditional without a logical wrapper keeps the same
// statement lowering.
function warn(flag, other) {
  flag ? other ? console.warn("one") : console.warn("two") : console.warn("three");
}
warn(false, false);
warn(true, false);

console.log("done");
