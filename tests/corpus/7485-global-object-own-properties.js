var _a;
globalThis.__direct = { n: 1 };
console.log(typeof globalThis.__direct, globalThis.__direct.n);

(_a = globalThis).__alias ?? (_a.__alias = { n: 2 });
console.log(typeof globalThis.__alias);
const g = globalThis;
g.__viaConst = { n: 3 };
console.log(typeof globalThis.__viaConst);
globalThis.__nullish ??= { n: 4 };
console.log(typeof globalThis.__nullish);

(_a = globalThis).__demo_config ?? (_a.__demo_config = {});
const globalConfig = globalThis.__demo_config;
function config(next) {
  if (next) Object.assign(globalConfig, next);
  return globalConfig;
}
config({ localeError: (issue) => `bad ${issue}` });
console.log(typeof globalConfig, typeof globalConfig.localeError, config().localeError("x"));
const pp = globalThis.__demo_config?.postProcessor;
console.log(pp === undefined, globalThis.__demo_config === globalConfig);
