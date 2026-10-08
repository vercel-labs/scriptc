// Copies keep each optional field's presence: object spread, rest
// bindings, Object.assign, conversion to a narrower declared type,
// structuredClone, and conversion to an untyped value.
interface Shape {
  kind: string;
  color?: string;
  size?: number;
}

function describe(label: string, shape: Shape): void {
  console.log(label, Object.keys(shape).join(","), "color" in shape, JSON.stringify(shape), shape);
}

const plain: Shape = { kind: "square" };
const cleared: Shape = { kind: "circle", color: undefined };
const styled: Shape = { kind: "star", color: "red", size: 3 };

// Same-shape spreads, with and without overrides.
describe("copy-plain", { ...plain });
describe("copy-cleared", { ...cleared });
describe("override", { ...plain, color: undefined });
describe("override-size", { ...cleared, size: 9 });

// Merging over defaults: an absent field keeps the earlier value, a
// present undefined replaces it.
const defaults: Shape = { kind: "base", color: "gray", size: 1 };
describe("merge-plain", { ...defaults, ...plain });
describe("merge-cleared", { ...defaults, ...cleared });
describe("merge-styled", { ...defaults, ...styled });
describe("merge-reverse", { ...cleared, ...defaults });

// Optional spread sources.
function withOverrides(overrides?: Shape): Shape {
  return { ...defaults, ...overrides };
}
describe("optional-none", withOverrides());
describe("optional-cleared", withOverrides(cleared));
describe("optional-plain", withOverrides(plain));

// Rest bindings copy only the remaining own properties.
const { kind: k1, ...rest1 } = plain;
const { kind: k2, ...rest2 } = cleared;
const { kind: k3, ...rest3 } = styled;
console.log(k1, rest1, Object.keys(rest1));
console.log(k2, rest2, Object.keys(rest2));
console.log(k3, rest3, Object.keys(rest3));

// Object.assign copies own properties only.
const target1: Shape = { kind: "t1", color: "blue" };
Object.assign(target1, plain);
describe("assign-plain", target1);
const target2: Shape = { kind: "t2", color: "blue" };
Object.assign(target2, cleared);
describe("assign-cleared", target2);

// A narrower declared type keeps presence.
interface Tinted {
  color?: string;
}
function tintOf(t: Tinted): string {
  return `${"color" in t} ${Object.hasOwn(t, "color")} ${t.color}`;
}
console.log(tintOf(plain), "/", tintOf(cleared), "/", tintOf(styled));

// structuredClone and untyped views.
const clonedPlain = structuredClone(plain);
const clonedCleared = structuredClone(cleared);
describe("clone-plain", clonedPlain);
describe("clone-cleared", clonedCleared);
const untypedPlain: unknown = plain;
const untypedCleared: unknown = cleared;
console.log(untypedPlain, untypedCleared);
console.log(Object.keys(untypedPlain as object), Object.keys(untypedCleared as object));
