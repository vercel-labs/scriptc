"use strict";

function read(value: Record<string, unknown>, key: string, optional: boolean): unknown {
  return optional ? value?.[key] : value[key];
}

for (const optional of [false, true]) {
  const values: number[] = [];
  values.length = 1;
  const view = values as unknown as Record<string, unknown>;
  const prototype: Record<string, unknown> = JSON.parse("{}");
  const marker: unknown = JSON.parse('{"marker":"getter failure"}');
  Object.defineProperty(prototype, "0", {
    configurable: true,
    get: function (this: unknown): unknown {
      console.log("receiver", this === view);
      delete prototype["0"];
      throw marker;
    },
  });
  Object.setPrototypeOf(view, prototype);
  try {
    console.log("unexpected", read(view, "0", optional));
  } catch (error) {
    console.log("caught", optional, error === marker);
  }
  console.log("after", read(view, "0", optional), values.length);
}

function setPrototype(values: number[], prototype: unknown): void {
  Object.setPrototypeOf(values as unknown as Record<string, unknown>, prototype as object | null);
}

function prototypeOf(values: number[]): unknown {
  return Object.getPrototypeOf(values as unknown as Record<string, unknown>);
}

// Each function crossing releases its checked view while the typed array lives.
for (let mode = 0; mode < 3; mode++) {
  const values: number[] = [];
  const prototype: unknown = mode === 0 ? Array.prototype : mode === 1 ? JSON.parse("{}") : null;
  setPrototype(values, prototype);
  console.log("owner", mode, prototypeOf(values) === prototype);
  Object.preventExtensions(values as unknown as Record<string, unknown>);
  setPrototype(values, prototype);
  console.log("unchanged", mode, prototypeOf(values) === prototype);
  try {
    setPrototype(values, JSON.parse("{}"));
    console.log("unexpected prototype change");
  } catch (error) {
    console.log("restricted", mode, error instanceof TypeError);
  }
}

const descendant: number[] = [];
try {
  Object.setPrototypeOf(Array.prototype, descendant);
  console.log("unexpected prototype cycle");
} catch (error) {
  console.log("implicit cycle", error instanceof TypeError);
}
