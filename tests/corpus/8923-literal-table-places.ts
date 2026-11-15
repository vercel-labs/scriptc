// Large literal tables evaluated more than once, or somewhere other than a
// module binding: every evaluation makes a new table of new rows.
interface Entry { key: string; value: number }

function make(): Entry[] {
  return [{ key: "m0", value: 0 }, { key: "m1", value: 2 }, { key: "m2", value: 4 }, { key: "m3", value: 6 }, { key: "m4", value: 8 }, { key: "m5", value: 10 }, { key: "m6", value: 12 }, { key: "m7", value: 14 }, { key: "m8", value: 16 }, { key: "m9", value: 18 }, { key: "m10", value: 20 }, { key: "m11", value: 22 }, { key: "m12", value: 24 }, { key: "m13", value: 26 }, { key: "m14", value: 28 }, { key: "m15", value: 30 }, { key: "m16", value: 32 }, { key: "m17", value: 34 }, { key: "m18", value: 36 }, { key: "m19", value: 38 }, { key: "m20", value: 40 }, { key: "m21", value: 42 }, { key: "m22", value: 44 }, { key: "m23", value: 46 }, { key: "m24", value: 48 }, { key: "m25", value: 50 }, { key: "m26", value: 52 }, { key: "m27", value: 54 }, { key: "m28", value: 56 }, { key: "m29", value: 58 }, { key: "m30", value: 60 }, { key: "m31", value: 62 }, { key: "m32", value: 64 }, { key: "m33", value: 66 }, { key: "m34", value: 68 }, { key: "m35", value: 70 }, { key: "m36", value: 72 }, { key: "m37", value: 74 }, { key: "m38", value: 76 }, { key: "m39", value: 78 }, { key: "m40", value: 80 }, { key: "m41", value: 82 }, { key: "m42", value: 84 }, { key: "m43", value: 86 }, { key: "m44", value: 88 }, { key: "m45", value: 90 }, { key: "m46", value: 92 }, { key: "m47", value: 94 }, { key: "m48", value: 96 }, { key: "m49", value: 98 }, { key: "m50", value: 100 }, { key: "m51", value: 102 }, { key: "m52", value: 104 }, { key: "m53", value: 106 }, { key: "m54", value: 108 }, { key: "m55", value: 110 }, { key: "m56", value: 112 }, { key: "m57", value: 114 }, { key: "m58", value: 116 }, { key: "m59", value: 118 }, { key: "m60", value: 120 }, { key: "m61", value: 122 }, { key: "m62", value: 124 }, { key: "m63", value: 126 }, { key: "m64", value: 128 }, { key: "m65", value: 130 }, { key: "m66", value: 132 }, { key: "m67", value: 134 }, { key: "m68", value: 136 }, { key: "m69", value: 138 }];
}
const first = make();
const second = make();
first[3].value = -1;
first.pop();
console.log("calls", first === second, first[0] === second[0], first.length, second.length, first[3].value, second[3].value);

function local(extra: string): number {
  const table = ["local-0", "local-1", "local-2", "local-3", "local-4", "local-5", "local-6", "local-7", "local-8", "local-9", "local-10", "local-11", "local-12", "local-13", "local-14", "local-15", "local-16", "local-17", "local-18", "local-19", "local-20", "local-21", "local-22", "local-23", "local-24", "local-25", "local-26", "local-27", "local-28", "local-29", "local-30", "local-31", "local-32", "local-33", "local-34", "local-35", "local-36", "local-37", "local-38", "local-39", "local-40", "local-41", "local-42", "local-43", "local-44", "local-45", "local-46", "local-47", "local-48", "local-49", "local-50", "local-51", "local-52", "local-53", "local-54", "local-55", "local-56", "local-57", "local-58", "local-59", "local-60", "local-61", "local-62", "local-63", "local-64", "local-65", "local-66", "local-67", "local-68", "local-69", "local-70", "local-71", "local-72", "local-73", "local-74", "local-75", "local-76", "local-77", "local-78", "local-79"];
  let n = 0;
  for (let i = 0; i < table.length; i++) n += table[i].length;
  table.push(extra);
  return n + table.length + table[table.length - 1].length;
}
console.log("local", local("x"), local("longer"));

function withDefault(table: string[] = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15", "d16", "d17", "d18", "d19", "d20", "d21", "d22", "d23", "d24", "d25", "d26", "d27", "d28", "d29", "d30", "d31", "d32", "d33", "d34", "d35", "d36", "d37", "d38", "d39", "d40", "d41", "d42", "d43", "d44", "d45", "d46", "d47", "d48", "d49", "d50", "d51", "d52", "d53", "d54", "d55", "d56", "d57", "d58", "d59", "d60", "d61", "d62", "d63", "d64", "d65", "d66", "d67", "d68", "d69"]): number {
  table.push("more");
  return table.length;
}
console.log("default", withDefault(), withDefault(), withDefault(["one"]));

const perPass: string[][] = [];
for (let pass = 0; pass < 3; pass++) {
  const table = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12", "p13", "p14", "p15", "p16", "p17", "p18", "p19", "p20", "p21", "p22", "p23", "p24", "p25", "p26", "p27", "p28", "p29", "p30", "p31", "p32", "p33", "p34", "p35", "p36", "p37", "p38", "p39", "p40", "p41", "p42", "p43", "p44", "p45", "p46", "p47", "p48", "p49", "p50", "p51", "p52", "p53", "p54", "p55", "p56", "p57", "p58", "p59", "p60", "p61", "p62", "p63", "p64", "p65"];
  table[0] = "pass " + pass;
  perPass.push(table);
}
console.log("loop", perPass[0][0], perPass[1][0], perPass[2][0], perPass[0] === perPass[1], perPass[2][65]);

class Holder {
  static shared: Entry[] = [{ key: "s0", value: 0 }, { key: "s1", value: 2 }, { key: "s2", value: 4 }, { key: "s3", value: 6 }, { key: "s4", value: 8 }, { key: "s5", value: 10 }, { key: "s6", value: 12 }, { key: "s7", value: 14 }, { key: "s8", value: 16 }, { key: "s9", value: 18 }, { key: "s10", value: 20 }, { key: "s11", value: 22 }, { key: "s12", value: 24 }, { key: "s13", value: 26 }, { key: "s14", value: 28 }, { key: "s15", value: 30 }, { key: "s16", value: 32 }, { key: "s17", value: 34 }, { key: "s18", value: 36 }, { key: "s19", value: 38 }, { key: "s20", value: 40 }, { key: "s21", value: 42 }, { key: "s22", value: 44 }, { key: "s23", value: 46 }, { key: "s24", value: 48 }, { key: "s25", value: 50 }, { key: "s26", value: 52 }, { key: "s27", value: 54 }, { key: "s28", value: 56 }, { key: "s29", value: 58 }, { key: "s30", value: 60 }, { key: "s31", value: 62 }, { key: "s32", value: 64 }, { key: "s33", value: 66 }, { key: "s34", value: 68 }, { key: "s35", value: 70 }, { key: "s36", value: 72 }, { key: "s37", value: 74 }, { key: "s38", value: 76 }, { key: "s39", value: 78 }, { key: "s40", value: 80 }, { key: "s41", value: 82 }, { key: "s42", value: 84 }, { key: "s43", value: 86 }, { key: "s44", value: 88 }, { key: "s45", value: 90 }, { key: "s46", value: 92 }, { key: "s47", value: 94 }, { key: "s48", value: 96 }, { key: "s49", value: 98 }, { key: "s50", value: 100 }, { key: "s51", value: 102 }, { key: "s52", value: 104 }, { key: "s53", value: 106 }, { key: "s54", value: 108 }, { key: "s55", value: 110 }, { key: "s56", value: 112 }, { key: "s57", value: 114 }, { key: "s58", value: 116 }, { key: "s59", value: 118 }, { key: "s60", value: 120 }, { key: "s61", value: 122 }, { key: "s62", value: 124 }, { key: "s63", value: 126 }, { key: "s64", value: 128 }, { key: "s65", value: 130 }, { key: "s66", value: 132 }, { key: "s67", value: 134 }, { key: "s68", value: 136 }, { key: "s69", value: 138 }];
  own: Entry[] = [{ key: "o0", value: 0 }, { key: "o1", value: 2 }, { key: "o2", value: 4 }, { key: "o3", value: 6 }, { key: "o4", value: 8 }, { key: "o5", value: 10 }, { key: "o6", value: 12 }, { key: "o7", value: 14 }, { key: "o8", value: 16 }, { key: "o9", value: 18 }, { key: "o10", value: 20 }, { key: "o11", value: 22 }, { key: "o12", value: 24 }, { key: "o13", value: 26 }, { key: "o14", value: 28 }, { key: "o15", value: 30 }, { key: "o16", value: 32 }, { key: "o17", value: 34 }, { key: "o18", value: 36 }, { key: "o19", value: 38 }, { key: "o20", value: 40 }, { key: "o21", value: 42 }, { key: "o22", value: 44 }, { key: "o23", value: 46 }, { key: "o24", value: 48 }, { key: "o25", value: 50 }, { key: "o26", value: 52 }, { key: "o27", value: 54 }, { key: "o28", value: 56 }, { key: "o29", value: 58 }, { key: "o30", value: 60 }, { key: "o31", value: 62 }, { key: "o32", value: 64 }, { key: "o33", value: 66 }, { key: "o34", value: 68 }, { key: "o35", value: 70 }, { key: "o36", value: 72 }, { key: "o37", value: 74 }, { key: "o38", value: 76 }, { key: "o39", value: 78 }, { key: "o40", value: 80 }, { key: "o41", value: 82 }, { key: "o42", value: 84 }, { key: "o43", value: 86 }, { key: "o44", value: 88 }, { key: "o45", value: 90 }, { key: "o46", value: 92 }, { key: "o47", value: 94 }, { key: "o48", value: 96 }, { key: "o49", value: 98 }, { key: "o50", value: 100 }, { key: "o51", value: 102 }, { key: "o52", value: 104 }, { key: "o53", value: 106 }, { key: "o54", value: 108 }, { key: "o55", value: 110 }, { key: "o56", value: 112 }, { key: "o57", value: 114 }, { key: "o58", value: 116 }, { key: "o59", value: 118 }, { key: "o60", value: 120 }, { key: "o61", value: 122 }, { key: "o62", value: 124 }, { key: "o63", value: 126 }, { key: "o64", value: 128 }, { key: "o65", value: 130 }, { key: "o66", value: 132 }, { key: "o67", value: 134 }, { key: "o68", value: 136 }, { key: "o69", value: 138 }];
  count(): number { return this.own.length + Holder.shared.length; }
}
const h1 = new Holder();
const h2 = new Holder();
h1.own[0].value = 123;
h1.own.push({ key: "extra", value: 0 });
console.log("class", h1.count(), h2.count(), h1.own === h2.own, h2.own[0].value, Holder.shared[69].key);

function* walk(): Generator<string> {
  const table = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12", "g13", "g14", "g15", "g16", "g17", "g18", "g19", "g20", "g21", "g22", "g23", "g24", "g25", "g26", "g27", "g28", "g29", "g30", "g31", "g32", "g33", "g34", "g35", "g36", "g37", "g38", "g39", "g40", "g41", "g42", "g43", "g44", "g45", "g46", "g47", "g48", "g49", "g50", "g51", "g52", "g53", "g54", "g55", "g56", "g57", "g58", "g59", "g60", "g61", "g62", "g63", "g64", "g65", "g66", "g67", "g68", "g69"];
  for (const item of table) yield item;
}
let walked = "";
let steps = 0;
for (const item of walk()) { steps++; if (steps % 30 === 0) walked += item + " "; }
console.log("generator", steps, walked);

async function later(): Promise<number> {
  const before = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15", "a16", "a17", "a18", "a19", "a20", "a21", "a22", "a23", "a24", "a25", "a26", "a27", "a28", "a29", "a30", "a31", "a32", "a33", "a34", "a35", "a36", "a37", "a38", "a39", "a40", "a41", "a42", "a43", "a44", "a45", "a46", "a47", "a48", "a49", "a50", "a51", "a52", "a53", "a54", "a55", "a56", "a57", "a58", "a59", "a60", "a61", "a62", "a63", "a64", "a65", "a66", "a67", "a68", "a69"];
  await Promise.resolve();
  const after = [{ key: "b0", value: 0 }, { key: "b1", value: 2 }, { key: "b2", value: 4 }, { key: "b3", value: 6 }, { key: "b4", value: 8 }, { key: "b5", value: 10 }, { key: "b6", value: 12 }, { key: "b7", value: 14 }, { key: "b8", value: 16 }, { key: "b9", value: 18 }, { key: "b10", value: 20 }, { key: "b11", value: 22 }, { key: "b12", value: 24 }, { key: "b13", value: 26 }, { key: "b14", value: 28 }, { key: "b15", value: 30 }, { key: "b16", value: 32 }, { key: "b17", value: 34 }, { key: "b18", value: 36 }, { key: "b19", value: 38 }, { key: "b20", value: 40 }, { key: "b21", value: 42 }, { key: "b22", value: 44 }, { key: "b23", value: 46 }, { key: "b24", value: 48 }, { key: "b25", value: 50 }, { key: "b26", value: 52 }, { key: "b27", value: 54 }, { key: "b28", value: 56 }, { key: "b29", value: 58 }, { key: "b30", value: 60 }, { key: "b31", value: 62 }, { key: "b32", value: 64 }, { key: "b33", value: 66 }, { key: "b34", value: 68 }, { key: "b35", value: 70 }, { key: "b36", value: 72 }, { key: "b37", value: 74 }, { key: "b38", value: 76 }, { key: "b39", value: 78 }, { key: "b40", value: 80 }, { key: "b41", value: 82 }, { key: "b42", value: 84 }, { key: "b43", value: 86 }, { key: "b44", value: 88 }, { key: "b45", value: 90 }, { key: "b46", value: 92 }, { key: "b47", value: 94 }, { key: "b48", value: 96 }, { key: "b49", value: 98 }, { key: "b50", value: 100 }, { key: "b51", value: 102 }, { key: "b52", value: 104 }, { key: "b53", value: 106 }, { key: "b54", value: 108 }, { key: "b55", value: 110 }, { key: "b56", value: 112 }, { key: "b57", value: 114 }, { key: "b58", value: 116 }, { key: "b59", value: 118 }, { key: "b60", value: 120 }, { key: "b61", value: 122 }, { key: "b62", value: 124 }, { key: "b63", value: 126 }, { key: "b64", value: 128 }, { key: "b65", value: 130 }, { key: "b66", value: 132 }, { key: "b67", value: 134 }, { key: "b68", value: 136 }, { key: "b69", value: 138 }];
  return before.length + after.length + after[69].value;
}

const nested: string[][] = [
  ["n0-0", "n0-1", "n0-2", "n0-3", "n0-4", "n0-5", "n0-6", "n0-7", "n0-8", "n0-9", "n0-10", "n0-11", "n0-12", "n0-13", "n0-14", "n0-15", "n0-16", "n0-17", "n0-18", "n0-19", "n0-20", "n0-21", "n0-22", "n0-23", "n0-24", "n0-25", "n0-26", "n0-27", "n0-28", "n0-29", "n0-30", "n0-31", "n0-32", "n0-33", "n0-34", "n0-35", "n0-36", "n0-37", "n0-38", "n0-39", "n0-40", "n0-41", "n0-42", "n0-43", "n0-44", "n0-45", "n0-46", "n0-47", "n0-48", "n0-49", "n0-50", "n0-51", "n0-52", "n0-53", "n0-54", "n0-55", "n0-56", "n0-57", "n0-58", "n0-59", "n0-60", "n0-61", "n0-62", "n0-63", "n0-64", "n0-65", "n0-66", "n0-67", "n0-68", "n0-69"],
  ["n1-0", "n1-1", "n1-2", "n1-3", "n1-4", "n1-5", "n1-6", "n1-7", "n1-8", "n1-9", "n1-10", "n1-11", "n1-12", "n1-13", "n1-14", "n1-15", "n1-16", "n1-17", "n1-18", "n1-19", "n1-20", "n1-21", "n1-22", "n1-23", "n1-24", "n1-25", "n1-26", "n1-27", "n1-28", "n1-29", "n1-30", "n1-31", "n1-32", "n1-33", "n1-34", "n1-35", "n1-36", "n1-37", "n1-38", "n1-39", "n1-40", "n1-41", "n1-42", "n1-43", "n1-44", "n1-45", "n1-46", "n1-47", "n1-48", "n1-49", "n1-50", "n1-51", "n1-52", "n1-53", "n1-54", "n1-55", "n1-56", "n1-57", "n1-58", "n1-59", "n1-60", "n1-61", "n1-62", "n1-63", "n1-64", "n1-65", "n1-66", "n1-67", "n1-68", "n1-69"],
  ["short"],
];
nested[0][0] = "edited";
console.log("nested", nested.length, nested[0].length, nested[0][0], nested[1][0], nested[1][69], nested[2][0]);

const table2d: string[][] = [
  ["r0c0", "r0c1", "r0c2"],
  ["r1c0", "r1c1", "r1c2"],
  ["r2c0", "r2c1", "r2c2"],
  ["r3c0", "r3c1", "r3c2"],
  ["r4c0", "r4c1", "r4c2"],
  ["r5c0", "r5c1", "r5c2"],
  ["r6c0", "r6c1", "r6c2"],
  ["r7c0", "r7c1", "r7c2"],
  ["r8c0", "r8c1", "r8c2"],
  ["r9c0", "r9c1", "r9c2"],
  ["r10c0", "r10c1", "r10c2"],
  ["r11c0", "r11c1", "r11c2"],
  ["r12c0", "r12c1", "r12c2"],
  ["r13c0", "r13c1", "r13c2"],
  ["r14c0", "r14c1", "r14c2"],
  ["r15c0", "r15c1", "r15c2"],
  ["r16c0", "r16c1", "r16c2"],
  ["r17c0", "r17c1", "r17c2"],
  ["r18c0", "r18c1", "r18c2"],
  ["r19c0", "r19c1", "r19c2"],
  ["r20c0", "r20c1", "r20c2"],
  ["r21c0", "r21c1", "r21c2"],
  ["r22c0", "r22c1", "r22c2"],
  ["r23c0", "r23c1", "r23c2"],
  ["r24c0", "r24c1", "r24c2"],
  ["r25c0", "r25c1", "r25c2"],
  ["r26c0", "r26c1", "r26c2"],
  ["r27c0", "r27c1", "r27c2"],
  ["r28c0", "r28c1", "r28c2"],
  ["r29c0", "r29c1", "r29c2"],
  ["r30c0", "r30c1", "r30c2"],
  ["r31c0", "r31c1", "r31c2"],
  ["r32c0", "r32c1", "r32c2"],
  ["r33c0", "r33c1", "r33c2"],
  ["r34c0", "r34c1", "r34c2"],
  ["r35c0", "r35c1", "r35c2"],
  ["r36c0", "r36c1", "r36c2"],
  ["r37c0", "r37c1", "r37c2"],
  ["r38c0", "r38c1", "r38c2"],
  ["r39c0", "r39c1", "r39c2"],
  ["r40c0", "r40c1", "r40c2"],
  ["r41c0", "r41c1", "r41c2"],
  ["r42c0", "r42c1", "r42c2"],
  ["r43c0", "r43c1", "r43c2"],
  ["r44c0", "r44c1", "r44c2"],
  ["r45c0", "r45c1", "r45c2"],
  ["r46c0", "r46c1", "r46c2"],
  ["r47c0", "r47c1", "r47c2"],
  ["r48c0", "r48c1", "r48c2"],
  ["r49c0", "r49c1", "r49c2"],
  ["r50c0", "r50c1", "r50c2"],
  ["r51c0", "r51c1", "r51c2"],
  ["r52c0", "r52c1", "r52c2"],
  ["r53c0", "r53c1", "r53c2"],
  ["r54c0", "r54c1", "r54c2"],
  ["r55c0", "r55c1", "r55c2"],
  ["r56c0", "r56c1", "r56c2"],
  ["r57c0", "r57c1", "r57c2"],
  ["r58c0", "r58c1", "r58c2"],
  ["r59c0", "r59c1", "r59c2"],
  ["r60c0", "r60c1", "r60c2"],
  ["r61c0", "r61c1", "r61c2"],
  ["r62c0", "r62c1", "r62c2"],
  ["r63c0", "r63c1", "r63c2"],
  ["r64c0", "r64c1", "r64c2"],
  ["r65c0", "r65c1", "r65c2"],
];
console.log("rows of rows", table2d.length, table2d[65].join(","), table2d[1] === table2d[2]);

const picked = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19", "c20", "c21", "c22", "c23", "c24", "c25", "c26", "c27", "c28", "c29", "c30", "c31", "c32", "c33", "c34", "c35", "c36", "c37", "c38", "c39", "c40", "c41", "c42", "c43", "c44", "c45", "c46", "c47", "c48", "c49", "c50", "c51", "c52", "c53", "c54", "c55", "c56", "c57", "c58", "c59", "c60", "c61", "c62", "c63", "c64", "c65", "c66", "c67", "c68", "c69"].filter((s) => s.endsWith("9")).join(",");
console.log("temporary", picked, ["i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i11", "i12", "i13", "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24", "i25", "i26", "i27", "i28", "i29", "i30", "i31", "i32", "i33", "i34", "i35", "i36", "i37", "i38", "i39", "i40", "i41", "i42", "i43", "i44", "i45", "i46", "i47", "i48", "i49", "i50", "i51", "i52", "i53", "i54", "i55", "i56", "i57", "i58", "i59", "i60", "i61", "i62", "i63", "i64", "i65", "i66", "i67", "i68", "i69"][69], ["j0", "j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9", "j10", "j11", "j12", "j13", "j14", "j15", "j16", "j17", "j18", "j19", "j20", "j21", "j22", "j23", "j24", "j25", "j26", "j27", "j28", "j29", "j30", "j31", "j32", "j33", "j34", "j35", "j36", "j37", "j38", "j39", "j40", "j41", "j42", "j43", "j44", "j45", "j46", "j47", "j48", "j49", "j50", "j51", "j52", "j53", "j54", "j55", "j56", "j57", "j58", "j59", "j60", "j61", "j62", "j63", "j64", "j65", "j66", "j67", "j68", "j69"].length);

later().then((n) => { console.log("async", n); });
