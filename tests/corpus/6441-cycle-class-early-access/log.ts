import { probe } from "./stats.ts";

class Base {
  static count = 1;
  static hello(): string {
    return "hello";
  }
}

export class Sink extends Base {
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  static describe(): string {
    return "sink";
  }
}

export const limit = 3;

export const probed = probe();
