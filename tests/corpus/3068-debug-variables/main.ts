import { reportOther } from "./other.ts";

const moduleValue = 42;
const moduleText = "module";

function inspect(input: number, enabled: boolean, fallback = 9): void {
  let value = input + 1;
  const text = "hello é";
  const update = (): void => {
    value += 2;
    console.log("capture", value); // debug: capture
  };
  console.log("locals", value, enabled, text, fallback); // debug: locals
  {
    const value = 99;
    console.log("inner", value); // debug: shadow
  }
  update();
  console.log("outer", value); // debug: restored
  const bytes = new Uint8Array([4, 5]);
  for (let i = 0; i < bytes.length; i++) {
    console.log("loop", i, bytes[i]); // debug: loop
  }
  for (const item of [6, 7, undefined]) {
    console.log("item"); // debug: item
    console.log(item);
  }
  if (enabled) {
    var hoisted = input + 10;
  } else {
    hoisted = 0;
  }
  console.log("hoisted", hoisted); // debug: hoisted
}

console.log("globals", moduleValue, moduleText); // debug: globals
inspect(3, true);
reportOther();
