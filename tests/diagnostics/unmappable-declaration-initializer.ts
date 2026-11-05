// An initializer is never dropped. This declaration's type has no lowering,
// so the declaration is refused where it is written — it cannot compile away
// with the call in its initializer, which would run under Node.
function touch(): number {
  return 1;
}
function run(): void {
  const ref: Intl.NumberFormat = touch() as unknown as Intl.NumberFormat;
}
run();
