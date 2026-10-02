declare function adjust(value: number): number;
declare function report(message: string, data: Uint8Array, flag: boolean): void;

let total = 7;

export function step(value: number): number {
  total += adjust(value);
  return total;
}

export function echo(value: string): string {
  return "wasm:" + value;
}

export function echoCString(value: string): string {
  return "cstr:" + value;
}

export function bytes(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) output[i] = value[i] + 1;
  report("hello λ", output, true);
  return output;
}

export function fail(): void {
  throw new Error("reactor failure");
}
