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
show("method", () => new Holder().method());
show("static", () => Holder.make());
show("literal", () => literal.method());
show("typed", () => typed());
show("void", () => nothing());
console.log(evaluations);
const results: unknown[] = [declared(), concise(), new Holder().method()];
console.log(results, results.every((value) => value === undefined));
