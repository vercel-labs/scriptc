import { prefix } from "./stats.ts";

export class Sink {
  private readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  write(line: string): void {
    console.log(`${prefix()}[${this.tag}] ${line}`);
  }
}

function makeLogger(): { make: (tag: string) => Sink } {
  return { make: (tag: string) => new Sink(tag) };
}

export const logger = makeLogger();
