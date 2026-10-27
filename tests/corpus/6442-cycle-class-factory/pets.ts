import { describe } from "./dogs.ts";

export class Pet {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak(): string {
    return describe(this.name);
  }
}
