/** `// @define: process.env.NAME="value"` lines in a corpus program's
 * directive head: scriptc builds the program with those `--define` values,
 * and the Node oracle runs with the variables set, the environment the
 * build fixes. Null when the head has none. */
export function programDefines(head: readonly string[]): {
  define: Record<string, string>;
  env: Record<string, string>;
} | null {
  const define: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const line of head) {
    const m = /^\/\/ @define:\s*process\.env\.(\w+)=(".*")\s*$/.exec(line);
    if (m === null) continue;
    const value = JSON.parse(m[2]!) as string;
    define[`process.env.${m[1]!}`] = value;
    env[m[1]!] = value;
  }
  return Object.keys(env).length === 0 ? null : { define, env };
}
