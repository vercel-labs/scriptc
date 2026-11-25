// The body shapes of a concise arrow whose result is declared `undefined` or
// `void`: a literal, a cast, a call, an untyped value, a conditional with
// lazy arms, a comma, `void e`. Every value here is undefined, as declared,
// so both sides print it; a body's effects run exactly as written.
function absent(): any {
  return JSON.parse("[]")[0];
}
const flag: boolean = process.argv.length < 99;
const held: any = absent();
const bag: any = JSON.parse("{}");
let effects = 0;
function effect(): void {
  effects++;
}
function typed(): undefined {
  effects++;
  return undefined;
}

const literal = (): undefined => undefined;
const parenthesized = (): undefined => (undefined);
const castLiteral = (): undefined => undefined as any;
const castParenthesized = (): undefined => (undefined as any);
const call = (): undefined => absent();
const castCall = (): undefined => absent() as any;
const nonNullCall = (): undefined => absent()!;
const value = (): undefined => held;
const member = (): undefined => bag.missing;
const typedCall = (): undefined => typed();
const conditional = (): undefined => (flag ? absent() : undefined);
const conditionalCast = (): undefined => (flag ? (undefined as any) : undefined);
const conditionalVoidArm = (): undefined => (flag ? absent() : void effect());
const conditionalVoidTaken = (): undefined => (flag ? void effect() : absent());
const conditionalNested = (): undefined =>
  flag ? (effects > 99 ? void effect() : absent()) : undefined;
const voidOperand = (): undefined => void effect();
const comma = (): undefined => (effect(), absent());

const show = (label: string, read: () => unknown): void => console.log(label, read(), effects);
show("literal", () => literal());
show("parenthesized", () => parenthesized());
show("castLiteral", () => castLiteral());
show("castParenthesized", () => castParenthesized());
show("call", () => call());
show("castCall", () => castCall());
show("nonNullCall", () => nonNullCall());
show("value", () => value());
show("member", () => member());
show("typedCall", () => typedCall());
show("conditional", () => conditional());
show("conditionalCast", () => conditionalCast());
show("conditionalVoidArm", () => conditionalVoidArm());
show("conditionalVoidTaken", () => conditionalVoidTaken());
show("conditionalNested", () => conditionalNested());
show("voidOperand", () => voidOperand());
show("comma", () => comma());

// The same bodies where the result is declared `void`: nothing is checked,
// and each runs for its effects.
const voidLiteral = (): void => undefined;
const voidCastLiteral = (): void => undefined as any;
const voidCall = (): void => absent();
const voidCastCall = (): void => absent() as any;
const voidValue = (): void => held;
const voidEffect = (): void => effect();
const voidConditional = (): void => (flag ? absent() : void effect());
const voidConditionalTaken = (): void => (flag ? void effect() : absent());
const voidVoidOperand = (): void => void effect();
const voidComma = (): void => (effect(), absent());
const voidNumber = (): void => 5 as any;
voidLiteral();
voidCastLiteral();
voidCall();
voidCastCall();
voidValue();
voidEffect();
voidConditional();
voidConditionalTaken();
voidVoidOperand();
voidComma();
voidNumber();
console.log("void bodies ran", effects);
