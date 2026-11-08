// A result declared `undefined` holds no value, so an untyped value returned
// into it is checked where it is returned. Every value here is undefined, as
// declared, and both sides print it; the failing check is scriptc's alone
// (tests/harness/dyncheck.test.ts).
function absent(): any {
  return JSON.parse("[]")[0];
}
const flag: boolean = process.argv.length < 99;
type Nothing = undefined;

let evaluations = 0;
function counted(): any {
  evaluations++;
  return absent();
}

function declared(): undefined {
  return absent();
}
function aliased(): Nothing {
  return absent();
}
function conditional(): undefined {
  return flag ? absent() : undefined;
}
function early(): undefined {
  if (!flag) return;
  return counted();
}
const concise = (): undefined => absent();
const conciseConditional = (): undefined => (flag ? counted() : undefined);
// A conditional body keeps its arms lazy: a `void e` arm runs for its effect
// only when it is selected, beside an untyped arm that is the result.
let effects = 0;
function effect(): void {
  effects++;
}
const conciseVoidArm = (): undefined => (flag ? counted() : void effect());
const conciseVoidTaken = (): undefined => (flag ? void effect() : counted());
const conciseNested = (): undefined =>
  flag ? (effects > 99 ? void effect() : counted()) : undefined;
class Holder {
  method(): undefined {
    return counted();
  }
  static make(): undefined {
    return absent();
  }
}
const literal = {
  method(): undefined {
    return absent();
  },
};
// `void` promises nothing about the value, and a typed `undefined` needs no
// check: neither is changed.
function typed(): undefined {
  return undefined;
}
function nothing(): void {
  return absent();
}

const show = (label: string, read: () => unknown): void => console.log(label, read());
show("declared", () => declared());
show("aliased", () => aliased());
show("conditional", () => conditional());
show("early", () => early());
show("concise", () => concise());
show("conciseConditional", () => conciseConditional());
show("conciseVoidArm", () => conciseVoidArm());
show("conciseVoidTaken", () => conciseVoidTaken());
show("conciseNested", () => conciseNested());
show("method", () => new Holder().method());
show("static", () => Holder.make());
show("literal", () => literal.method());
show("typed", () => typed());
show("void", () => nothing());
console.log(evaluations, effects);
const results: unknown[] = [declared(), concise(), new Holder().method()];
console.log(results, results.every((value) => value === undefined));
