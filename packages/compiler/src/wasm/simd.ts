/** Integer SIMD metadata shared by stack validation and LLVM lowering. */
export interface SimdIntegerOp {
  bits: number;
  kind:
    | "compare"
    | "all-true"
    | "bitmask"
    | "shift"
    | "unary"
    | "binary"
    | "extend"
    | "extmul"
    | "pairwise"
    | "dot"
    | "saturating"
    | "average"
    | "narrow"
    | "popcnt";
  operation: string;
}

export function simdIntegerOp(sub: number): SimdIntegerOp | null {
  if (sub >= 0x23 && sub <= 0x40) {
    const index = sub - 0x23;
    const conditions = ["eq", "ne", "slt", "ult", "sgt", "ugt", "sle", "ule", "sge", "uge"];
    return {
      bits: 8 << Math.floor(index / 10),
      kind: "compare",
      operation: conditions[index % 10]!,
    };
  }
  if (sub >= 0xd6 && sub <= 0xdb) {
    const conditions = ["eq", "ne", "slt", "sgt", "sle", "sge"];
    return { bits: 64, kind: "compare", operation: conditions[sub - 0xd6]! };
  }
  for (let group = 0; group < 4; group++) {
    if (sub === 0x63 + 0x20 * group) return { bits: 8 << group, kind: "all-true", operation: "" };
    if (sub === 0x64 + 0x20 * group) return { bits: 8 << group, kind: "bitmask", operation: "" };
  }
  for (let group = 0; group < 4; group++) {
    const bits = 8 << group;
    const shift = sub - (0x6b + 0x20 * group);
    if (shift >= 0 && shift < 3)
      return { bits, kind: "shift", operation: ["shl", "ashr", "lshr"][shift]! };
    if (sub === 0x60 + 0x20 * group) return { bits, kind: "unary", operation: "abs" };
    if (sub === 0x61 + 0x20 * group) return { bits, kind: "unary", operation: "neg" };
    if (sub === 0x6e + 0x20 * group) return { bits, kind: "binary", operation: "add" };
    if (sub === 0x71 + 0x20 * group) return { bits, kind: "binary", operation: "sub" };
    if (group > 0 && sub === 0x75 + 0x20 * group) return { bits, kind: "binary", operation: "mul" };
    const minmax = sub - (0x76 + 0x20 * group);
    if (group < 3 && minmax >= 0 && minmax < 4)
      return { bits, kind: "binary", operation: ["min_s", "min_u", "max_s", "max_u"][minmax]! };
  }
  for (let group = 0; group < 3; group++) {
    const bits = 16 << group;
    const extend = sub - (0x87 + 0x20 * group);
    if (extend >= 0 && extend < 4)
      return { bits, kind: "extend", operation: ["low_s", "high_s", "low_u", "high_u"][extend]! };
    const multiply = sub - (0x9c + 0x20 * group);
    if (multiply >= 0 && multiply < 4)
      return { bits, kind: "extmul", operation: ["low_s", "high_s", "low_u", "high_u"][multiply]! };
  }
  if (sub >= 0x7c && sub <= 0x7f)
    return { bits: sub < 0x7e ? 16 : 32, kind: "pairwise", operation: sub % 2 === 0 ? "s" : "u" };
  if (sub === 0xba) return { bits: 32, kind: "dot", operation: "s" };
  for (let group = 0; group < 2; group++) {
    const bits = 8 << group;
    const add = sub - (0x6f + 0x20 * group);
    const subtract = sub - (0x72 + 0x20 * group);
    if (add >= 0 && add < 2)
      return { bits, kind: "saturating", operation: add === 0 ? "add_s" : "add_u" };
    if (subtract >= 0 && subtract < 2)
      return { bits, kind: "saturating", operation: subtract === 0 ? "sub_s" : "sub_u" };
    if (sub === 0x7b + 0x20 * group) return { bits, kind: "average", operation: "" };
    const narrow = sub - (0x65 + 0x20 * group);
    if (narrow >= 0 && narrow < 2)
      return { bits, kind: "narrow", operation: narrow === 0 ? "s" : "u" };
  }
  if (sub === 0x82) return { bits: 16, kind: "saturating", operation: "q15" };
  if (sub === 0x62) return { bits: 8, kind: "popcnt", operation: "" };
  return null;
}

/** Floating-point SIMD metadata. Arithmetic families are added separately. */
export interface SimdFloatOp {
  bits: number;
  kind: "compare" | "unary" | "binary" | "convert";
  operation: string;
}

export function simdFloatOp(sub: number): SimdFloatOp | null {
  if (sub >= 0x41 && sub <= 0x4c) {
    const index = sub - 0x41;
    return {
      bits: index < 6 ? 32 : 64,
      kind: "compare",
      operation: ["oeq", "une", "olt", "ogt", "ole", "oge"][index % 6]!,
    };
  }
  for (let group = 0; group < 2; group++) {
    const bits = group === 0 ? 32 : 64;
    if (sub === 0xe0 + 12 * group) return { bits, kind: "unary", operation: "abs" };
    if (sub === 0xe1 + 12 * group) return { bits, kind: "unary", operation: "neg" };
    if (sub === 0xea + 12 * group) return { bits, kind: "binary", operation: "pmin" };
    if (sub === 0xeb + 12 * group) return { bits, kind: "binary", operation: "pmax" };
  }
  for (let group = 0; group < 2; group++) {
    const bits = group === 0 ? 32 : 64;
    if (sub === 0xe3 + 12 * group) return { bits, kind: "unary", operation: "sqrt" };
    const binary = sub - (0xe4 + 12 * group);
    if (binary >= 0 && binary < 6)
      return {
        bits,
        kind: "binary",
        operation: ["add", "sub", "mul", "div", "min", "max"][binary]!,
      };
  }
  if (sub >= 0x67 && sub <= 0x6a)
    return {
      bits: 32,
      kind: "unary",
      operation: ["ceil", "floor", "trunc", "nearest"][sub - 0x67]!,
    };
  if (sub === 0x74 || sub === 0x75 || sub === 0x7a || sub === 0x94)
    return {
      bits: 64,
      kind: "unary",
      operation:
        sub === 0x74 ? "ceil" : sub === 0x75 ? "floor" : sub === 0x7a ? "trunc" : "nearest",
    };
  if (sub === 0x5e) return { bits: 64, kind: "convert", operation: "demote" };
  if (sub === 0x5f) return { bits: 32, kind: "convert", operation: "promote" };
  if (sub >= 0xf8 && sub <= 0xff) {
    const index = sub - 0xf8;
    return {
      bits: index < 4 ? 32 : 64,
      kind: "convert",
      operation: `${index % 4 < 2 ? "trunc" : "from"}_${index % 2 === 0 ? "s" : "u"}`,
    };
  }
  return null;
}

/** Strict operations chosen as fixed, portable relaxed projections. */
export function relaxedSimdAlias(sub: number): number {
  if (sub === 0x100) return 0x0e;
  if (sub >= 0x101 && sub <= 0x104) return [0xf8, 0xf9, 0xfc, 0xfd][sub - 0x101]!;
  if (sub >= 0x109 && sub <= 0x10c) return 0x52;
  if (sub >= 0x10d && sub <= 0x110) return [0xe8, 0xe9, 0xf4, 0xf5][sub - 0x10d]!;
  if (sub === 0x111) return 0x82;
  return sub;
}

export function relaxedSimdArity(sub: number): number {
  if (sub < 0x100 || sub > 0x113) return 0;
  if (sub >= 0x101 && sub <= 0x104) return 1;
  if ((sub >= 0x105 && sub <= 0x10c) || sub === 0x113) return 3;
  return 2;
}
