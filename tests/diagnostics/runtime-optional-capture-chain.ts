function logical(values: string[], present: string): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log((present && value)?.length);
  value = values.slice(1)[0];
  read();
}

function conditional(values: string[], present: boolean): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log((present ? value : value)?.length);
  value = values.slice(1)[0];
  read();
}

function defaults(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const readOr = () => console.log((value || "fallback")?.length);
  const readNullish = () => console.log((value ?? "fallback")?.length);
  value = values.slice(1)[0];
  readOr();
  readNullish();
}

function condition(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log((value ? "yes" : "no")?.length);
  value = values.slice(1)[0];
  read();
}

function multipleArms(values: (string | number)[]): void {
  let value = values[0];
  if (!value) return;
  value = 1 as unknown as string;
  const read = () => console.log(value.length);
  read();
}

function commaCall(callbacks: (() => void)[], mark: () => void): void {
  let callback = callbacks[0];
  if (!callback) return;
  const call = () => (mark(), callback)();
  callback = callbacks.slice(1)[0];
  call();
}

logical(["first"], "yes");
conditional(["first"], true);
defaults(["first"]);
condition(["first"]);
multipleArms(["first"]);
commaCall([() => {}], () => {});
