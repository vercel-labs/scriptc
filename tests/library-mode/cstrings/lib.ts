// cstring conformance fixture: NUL-terminated text in both directions and
// through a callback channel. `withNul` and `echoNul` produce text holding
// U+0000, which a C string cannot carry.
declare function log(text: string, n: number): void;

export function greet(name: string): string {
  return `hello, ${name}!`;
}

export function length(text: string): number {
  return text.length;
}

export function echo(text: string): number {
  log(text.toUpperCase(), text.length);
  return 1;
}

export function withNul(): string {
  return "a\u0000b";
}

export function echoNul(): number {
  log("x\u0000y", 3);
  return 1;
}
