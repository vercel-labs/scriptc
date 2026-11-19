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

multipleArms(["first"]);
commaCall([() => {}], () => {});
