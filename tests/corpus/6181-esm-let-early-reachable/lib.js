let mixin;
export function cliui(opts) {
  if (opts !== undefined) mixin = opts;
  return describe();
}

let earlyResult;
try {
  earlyResult = cliui({ width: 1 });
} catch (e) {
  earlyResult = `${e.name}: ${e.message}`;
}
export const early = earlyResult;

let calls;
function describe() {
  calls = calls === undefined ? 1 : calls + 1;
  return `${calls} ${mixin === undefined ? 'none' : mixin.width}`;
}
