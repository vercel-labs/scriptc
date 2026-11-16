let current = 1;
export { current as default };
export function advance(): void {
  current = 2;
}
