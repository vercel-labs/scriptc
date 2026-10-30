import { describe, kind, mark } from "./util.ts";

export const version = 3;
export const marked = mark({});
console.log("core body", kind(), describe());
