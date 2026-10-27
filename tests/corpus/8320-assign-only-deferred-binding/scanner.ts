// Module bindings that only assignments use after their declarations.
export function defaultEnd(bytes: Uint8Array, start: number): number {
  return start + bytes.length;
}

let valueEnd: (bytes: Uint8Array, start: number) => number = defaultEnd;
let format: (value: number) => string = (value) => `#${value}`;
let installs = 0;

export function useScanner(scan: (bytes: Uint8Array, start: number) => number): void {
  valueEnd = (bytes, start) => scan(bytes, start) + 1;
  installs++;
}

export function useFormat(next: (value: number) => string): (value: number) => string {
  return (format = next);
}

export function installCount(): number {
  return installs;
}
