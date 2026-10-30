"use strict";

type Entry = { label: string };
const values: number[] = [1];
values.length = 2;
const source: (number[] | Entry | null)[] = [values, { label: "record" }, null];
const stream: ReadableStream<unknown> = ReadableStream.from(source);
const reader = stream.getReader();
const view = (await reader.read()).value as Record<string, unknown>;
const prototype: Record<string, unknown> = JSON.parse("{}");
Object.defineProperty(prototype, "1", {
  get: function (this: unknown): number {
    console.log("getter receiver", this === view);
    return 7;
  },
  set: function (this: unknown, value: unknown): void {
    console.log("setter receiver", this === view, value);
    values[0] = 9;
  },
});
Object.setPrototypeOf(view, prototype);
console.log("get", view["1"]);
view["1"] = "setter";
console.log("source", values[0], values.length, Object.hasOwn(view, "1"));
const record = (await reader.read()).value as Record<string, unknown>;
console.log("record", record["label"]);
console.log("null", (await reader.read()).value === null);
console.log("end", (await reader.read()).done);
