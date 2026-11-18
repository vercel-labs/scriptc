import { announce } from "./boot.ts";

console.log("events body");
export const started = announce();
export class Event {
  readonly type: string;
  constructor(type: string) {
    this.type = type;
  }
}
