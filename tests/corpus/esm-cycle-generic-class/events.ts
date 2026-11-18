import { probeEarly, probeLate } from "./boot.ts";

console.log("events body");
export const early = probeEarly();
export class CustomEvent<T = unknown> {
  readonly type: string;
  readonly detail: T | undefined;
  constructor(type: string, detail?: T) {
    this.type = type;
    this.detail = detail;
  }
}
export function makeCustomEvent<T>(detail: T): CustomEvent<T> {
  return new CustomEvent("boot", detail);
}
export const late = probeLate();
