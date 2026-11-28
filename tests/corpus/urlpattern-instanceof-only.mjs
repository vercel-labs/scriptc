// `instanceof` alone must select the URLPattern runtime unit (the tag test
// lives there), so a program that never constructs a pattern still links.
console.log(
  {} instanceof URLPattern,
  undefined instanceof URLPattern,
  "/a" instanceof URLPattern,
);
