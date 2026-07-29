const ORACLE_ENVIRONMENT_KEYS = [
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATH",
  "SCRIPTC_TEST_ENV",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "windir",
];

/**
 * Environment inputs that can change observable Node oracle output in the
 * corpus without changing program bytes. Values are length-framed so unset,
 * empty, and delimiter-containing variables remain distinct.
 */
export function oracleEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
  return ORACLE_ENVIRONMENT_KEYS.map((key) => {
    const value = env[key];
    return value === undefined ? `${key}:unset;` : `${key}:${value.length}:${value};`;
  }).join("");
}
