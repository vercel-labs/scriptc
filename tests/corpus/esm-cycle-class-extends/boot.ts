import { Event } from "./events.ts";

export class BootEvent extends Event {
  constructor(type: string) {
    super(type);
  }
}

export function announce(): string {
  return "boot";
}
