import { label, other } from "./alpha.ts";

function guard(read: () => string): string {
  try {
    return read();
  } catch (error) {
    return error instanceof ReferenceError ? `ReferenceError: ${error.message}` : "other error";
  }
}

export class Probe {
  static helper(): string {
    return guard(() => `label ${label}`);
  }
  static result = this.helper();
}

export class Lazy {
  static read(): string {
    return guard(() => `other ${other}`);
  }
  static describe(): string {
    return `lazy ${other}`;
  }
  static value = [0].map(() => this.read()).join("");
}
