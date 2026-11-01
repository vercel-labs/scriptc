// Statement-position `void e` — the fire-and-forget idiom (`void poll();`,
// `void main();`): the operand evaluates for effect, the undefined result is
// discarded. Value-position `void` stays fenced.
let n = 0;
function bump(): number {
  n += 1;
  return n;
}
async function tick(label: string): Promise<void> {
  console.log(label, bump());
}
void bump();
void tick("tick");
void (n += 10);
console.log("n =", n);
function returnUndefined(): unknown {
  return void bump();
}
const arrowUndefined = (): unknown => void bump();
function returnVoid(): void {
  return void bump();
}
function showOrder(first: number, value: unknown, last: number): void {
  console.log(first, value, last, n);
}
showOrder(bump(), void bump(), bump());
console.log("returns", returnUndefined(), arrowUndefined(), n);
returnVoid();
const initialized = void bump();
console.log("initialized", initialized, n);
console.log("branch", n > 0 ? void bump() : 0, n);
console.log("lazy", n < 0 && void bump(), n);
console.log("boolean", Boolean(void bump()), n);
console.log("typeof", typeof (void bump()), n);
console.log("nested typeof", typeof (bump(), void bump()), n);
console.log("nested number", Number((bump(), void bump())), n);
console.log("equal", (void bump()) === undefined, n);
console.log("unequal", (void bump()) !== undefined, n);
console.log("reversed", undefined === (void bump()), n);
console.log("both", (void bump()) === (void bump()), n);
console.log("ordered", (void (n *= 10)) === (void bump()), n);
console.log("loose null", (void bump()) == null, (void bump()) != null, n);
console.log("loose reversed null", null == (void bump()), null != (void bump()), n);
console.log("loose undefined", (void bump()) == undefined, (void bump()) != undefined, n);
console.log("loose reversed undefined", undefined == (void bump()), undefined != (void bump()), n);
console.log("loose ordered", (void (n *= 10)) == (void bump()), n);
function returnNestedVoid(): void {
  return (bump(), void bump());
}
returnNestedVoid();
console.log("nested", n);
function returnNestedUndefined(): unknown {
  return (bump(), void bump());
}
console.log("nested value", returnNestedUndefined(), n);
function fail(): number {
  bump();
  throw new Error("operand failed");
}
try {
  console.log("nested number throw", Number((bump(), void fail())));
} catch (error) {
  if (error instanceof Error) console.log("number caught", error.message, n);
}
try {
  showOrder(bump(), void fail(), bump());
} catch (error) {
  if (error instanceof Error) console.log(error.message, n);
}
try {
  console.log("loose throw", (void fail()) == null);
} catch (error) {
  if (error instanceof Error) console.log("loose caught", error.message, n);
}
async function main(): Promise<void> {
  await tick("awaited");
  const direct = await Promise.all([Promise.resolve(bump()), void bump(), (bump(), void bump()), Promise.resolve(bump())]);
  console.log("all", direct[0], direct[1], direct[2], direct[3], n);
  const optional = n > 0 ? tick("optional") : undefined;
  const staged = await Promise.all([Promise.resolve(bump()), void bump(), optional, Promise.resolve(bump())]);
  console.log("staged all", staged[0], staged[1], staged[2], staged[3], n);
  try {
    await Promise.all([Promise.resolve(bump()), void fail(), Promise.resolve(bump())]);
  } catch (error) {
    if (error instanceof Error) console.log("all caught", error.message, n);
  }
  try {
    await Promise.all([optional, Promise.resolve(bump()), void fail(), Promise.resolve(bump())]);
  } catch (error) {
    if (error instanceof Error) console.log("staged all caught", error.message, n);
  }
  console.log("done", n);
}
void main();
