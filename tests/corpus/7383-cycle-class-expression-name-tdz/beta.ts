import { label, other } from "./alpha.ts";

function guard(read: () => string): string {
  try {
    return read();
  } catch (error) {
    return error instanceof ReferenceError ? `ReferenceError: ${error.message}` : "other error";
  }
}

export const Probe = class ProbeImpl {
  static helper(): string {
    return guard(() => `label ${label}`);
  }
  static result = ProbeImpl.helper();
};

export const Lazy = class LazyImpl {
  static read(): string {
    return guard(() => `other ${other}`);
  }
  static describe(): string {
    return `lazy ${other}`;
  }
  static value = [0].map(() => LazyImpl.read()).join("");
};
