/* @noflow */
// `@noflow` turns off Flow's checking, not its syntax: the module is still
// written with types, and compiles as a Flow module.
export function label(count: number, unit: string): string {
  return count + ' ' + unit + (count === 1 ? '' : 's');
}
