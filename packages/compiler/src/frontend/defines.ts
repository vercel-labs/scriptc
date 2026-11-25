/** `--define` values, keyed `process.env.NAME`: the executable sets each
 * variable when it starts, and the JavaScript `if` statements they decide
 * resolve at build time. */
export type Defines = Readonly<Record<string, string>>;

export function definedEnvValue(defines: Defines | undefined, name: string): string | undefined {
  return defines?.[`process.env.${name}`];
}
