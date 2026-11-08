function initial(): string {
  let text = "";
  for (const part of ["co", "ld"]) text += part;
  return text;
}
export let mode: string = initial();
export let changes = 0;
export function setMode(to: string): void {
  mode = to;
  changes++;
}
