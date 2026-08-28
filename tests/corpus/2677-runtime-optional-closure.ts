function run(values: string[]): void {
  let value = values[0];
  if (!value) return;

  const printLength = () => {
    {
      const value = "shadow";
      if (value.length === 0) return;
    }
    console.log(value.length);
  };

  value = values.slice(1)[0];
  printLength();
}

try {
  run(["first"]);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}

function capturedNarrow(values: string[]): () => string {
  let value = values[0];
  if (!value) return () => "fallback";
  return () => value;
}

console.log(capturedNarrow(["kept"])());

function capturedOptionalChain(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const printLength = () => {
    console.log("property", value?.length);
    console.log("element", (value)?.[0]);
    console.log("comma", (values.length, value)?.length);
  };
  value = values.slice(1)[0];
  printLength();
}

capturedOptionalChain(["first"]);
capturedOptionalChain(["first", "second"]);

function capturedOptionalCall(callbacks: (() => string)[]): void {
  let callback = callbacks[0];
  if (!callback) return;
  const call = () => console.log(callback?.());
  callback = callbacks.slice(1)[0];
  call();
}

capturedOptionalCall([() => "called"]);
capturedOptionalCall([() => "first", () => "second"]);

function capturedUnionResult(values: { payload: string | number }[]): void {
  let value = values[0];
  if (!value) return;
  const printPayload = () => console.log(value?.payload);
  value = values.slice(1)[0];
  printPayload();
}

capturedUnionResult([{ payload: "first" }]);
capturedUnionResult([{ payload: "first" }, { payload: 2 }]);

function wrappedDirectRead(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log((value).length);
  value = values.slice(1)[0];
  read();
}

try {
  wrappedDirectRead(["first"]);
} catch (error) {
  console.log("wrapped", error instanceof TypeError, (error as Error).message);
}

function directCapturedCall(callbacks: (() => void)[]): void {
  let callback = callbacks[0];
  if (!callback) return;
  const call = () => (callback as () => void)();
  callback = callbacks.slice(1)[0];
  call();
}

try {
  directCapturedCall([() => console.log("called")]);
} catch (error) {
  console.log("direct call", error instanceof TypeError, (error as Error).message);
}

function assertedOptionalChain(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log("asserted", (value as string)?.length, (value!)?.length);
  value = values.slice(1)[0];
  read();
}

assertedOptionalChain(["first"]);
assertedOptionalChain(["first", "second"]);

function unrelatedCapture(): void {
  let value: string | number = "plain";
  if (typeof value === "string") {
    const read = () => value?.length;
    console.log("unrelated", read());
  }
}

function aliasedCapture(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const read = () => {
    const copy = value;
    console.log(copy.length);
  };
  value = values.slice(1)[0];
  read();
}

try {
  aliasedCapture(["first"]);
} catch (error) {
  console.log("alias", error instanceof TypeError, (error as Error).message);
}
aliasedCapture(["first", "second"]);

function ordinaryAssertion(value: string | number): void {
  console.log("ordinary assertion", (value as string)?.length);
}

ordinaryAssertion("plain");

unrelatedCapture();

function directCapturedElement(values: string[][]): void {
  let value = values[0];
  if (!value) return;
  const read = () => console.log(value[0]);
  value = values.slice(1)[0];
  read();
}

try {
  directCapturedElement([["first"]]);
} catch (error) {
  console.log("direct element", error instanceof TypeError, (error as Error).message);
}

const unionValues: (string | number)[] = ["first", 2];
console.log("union probe", unionValues.slice(2)[0] ?? "missing", unionValues.slice(0)[0], unionValues.slice(1)[0]);

function captureMutationThenOuterRead(values: string[]): void {
  let value = values[0];
  if (!value) return;
  const clear = () => {
    value = values.slice(1)[0];
  };
  clear();
  console.log(value.length);
}

try {
  captureMutationThenOuterRead(["first"]);
} catch (error) {
  console.log("capture mutation", error instanceof TypeError, (error as Error).message);
}
