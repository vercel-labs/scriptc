// @transform-types
// `<T>process.env` is the environment object, as `process.env as T` is: a
// read, a write, a delete, a key test and a comparison through the
// angle-bracket assertion reach the environment itself, not a copy of it.
type Env = Record<string, string | undefined>;

process.env.SCRIPTC_ANGLE_PROBE = "set";
console.log((<Env>process.env).SCRIPTC_ANGLE_PROBE, (<Env>process.env)["SCRIPTC_ANGLE_PROBE"]);

(<Env>process.env).SCRIPTC_ANGLE_PROBE = "written";
console.log(process.env.SCRIPTC_ANGLE_PROBE);

(<Env>process.env)["SCRIPTC_ANGLE_OTHER"] = "bracket";
console.log(process.env.SCRIPTC_ANGLE_OTHER, "SCRIPTC_ANGLE_OTHER" in <Env>process.env);

const key: string = process.argv.length > 99 ? "x" : "SCRIPTC_ANGLE_KEYED";
(<Env>process.env)[key] = "keyed";
console.log(
  process.env.SCRIPTC_ANGLE_KEYED,
  Object.keys(<Env>process.env).includes("SCRIPTC_ANGLE_KEYED"),
);

console.log(<Env>process.env === process.env, <Env>process.env === (process.env as Env));

delete (<Env>process.env).SCRIPTC_ANGLE_OTHER;
console.log(
  "SCRIPTC_ANGLE_OTHER" in process.env,
  Object.hasOwn(process.env, "SCRIPTC_ANGLE_OTHER"),
);

delete (<Env>process.env)[key];
console.log(Object.keys(process.env).includes("SCRIPTC_ANGLE_KEYED"));

// Nested with the other wrappers that leave no trace at run time.
(<Env>(<unknown>process.env)).SCRIPTC_ANGLE_PROBE = "double";
console.log(process.env.SCRIPTC_ANGLE_PROBE);
(<Env>process.env)!.SCRIPTC_ANGLE_PROBE = "nonnull";
console.log(process.env.SCRIPTC_ANGLE_PROBE);
((<Env>process.env) satisfies Env).SCRIPTC_ANGLE_PROBE = "satisfies";
console.log(process.env.SCRIPTC_ANGLE_PROBE);

// The harness's known variable, read through the assertion.
console.log((<Env>process.env).SCRIPTC_TEST_ENV);
