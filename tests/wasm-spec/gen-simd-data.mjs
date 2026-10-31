// Generate minimal modules for the standardized SIMD128 instruction set.
// No WAT assembler is needed. Keep the byte encodings visible for decoder tests.
import { writeFileSync } from "node:fs";

const u32 = (n) => {
  const out = [];
  do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)); } while (n);
  return out;
};
const section = (id, data) => [id, ...u32(data.length), ...data];
const name = (s) => [...u32(s.length), ...Buffer.from(s)];
const fd = (op, ...imm) => [253, ...u32(op), ...imm];
const i32 = (n) => {
  const out = [65];
  for (;;) {
    const b = n & 127; n >>= 7;
    if ((n === 0 && !(b & 64)) || (n === -1 && (b & 64))) { out.push(b); return out; }
    out.push(b | 128);
  }
};
const a = [0, 127, 128, 255, 15, 16, 31, 32, 63, 64, 1, 2, 3, 4, 5, 6];
const b = [...a].reverse();
const v = (bytes = a) => fd(12, ...bytes);
const fixtures = [];
function add(label, instructions, result = 127, width = 0, locals = [0], data = a, floatOutput = 0) {
  const body = [...locals, ...instructions, 11];
  const bytes = [0,97,115,109,1,0,0,0,
    ...section(1, [1,96,1,127,1,result]), ...section(3, [1,0]),
    ...section(5,[1,0,1]),
    ...section(7,[2,...name("run"),0,0,...name("memory"),2,0]),
    ...section(10,[1,...u32(body.length),...body]),
    ...section(11,[1,0,...i32(32),11,...u32(data.length),...data])];
  fixtures.push({ name: label, base64: Buffer.from(bytes).toString("base64"), width, ...(floatOutput ? {floatOutput} : {}) });
}
const output = (expr) => [...i32(0), ...expr, ...fd(11,0,0), ...i32(0)];
for (let op = 0; op <= 10; op++) {
  const width = op === 0 ? 16 : op <= 6 ? 8 : 1 << (op - 7);
  add(`memory-${op}`, output([32,0,...fd(op,0,0)]),127,width);
}
add("store", [...i32(0),...v(),...fd(11,0,0),...i32(0)]);
add("store-param", [32,0,...v(),...fd(11,0,0),...i32(0)],127,16);
add("load-offset",output([32,0,...fd(0,0,...u32(1))]),127,16);
add("load-offset-overflow",output([32,0,...fd(0,0,...u32(0xffffffff))]),127,16);
add("store-offset-overflow",[32,0,...v(),...fd(11,0,...u32(0xffffffff)),...i32(0)],127,16);
add("dropped-load",[32,0,...fd(0,0,0),26,...i32(0)],127,16);
add("unused-local-load",[32,0,...fd(0,0,0),33,1,...i32(0)],127,16,[1,1,123]);
add("const", output(v()));
add("shuffle", output([...v(),...v(b),...fd(13,...[31,0,17,2,29,4,21,6,23,8,25,10,27,12,19,14])]));
add("swizzle", output([...v(),...v([0,15,16,31,127,128,255,1,14,13,12,11,10,9,8,7]),...fd(14)]));
const scalar = (group) => group <= 2 ? [32,0] : group === 3 ? [66,127] : group === 4 ? [67,0,0,0,128] : [68,0,0,0,0,0,0,0,128];
for (let op=15;op<=20;op++) add(`splat-${op}`,output([...scalar(op-15),...fd(op)]));
for (let op=21;op<=34;op++) {
  const group = op<=23?0:op<=26?1:op<=28?2:op<=30?3:op<=32?4:5;
  const count = group===0?16:group===1?8:group===2||group===4?4:2;
  const replace = [23,26,28,30,32,34].includes(op);
  if (replace) add(`replace-${op}`,output([...v(),...scalar(group),...fd(op,count-1)]));
  else {
    const t = group<=2?127:group===3?126:group===4?125:124;
    add(`extract-${op}`, [...v(),...fd(op,group===0?2:group===1?1:count-1)],t);
  }
}
for (let op=77;op<=83;op++) {
  const expr = [...v(),...(op!==77&&op!==83?v(b):[]),...(op===82?v(new Array(16).fill(85)):[]),...fd(op)];
  add(`bitwise-${op}`,op===83?expr:output(expr));
}
add("any-zero",[...v(new Array(16).fill(0)),...fd(83)]);
for (let op=84;op<=91;op++) {
  const width = 1 << ((op-84)%4);
  const expr = [32,0,...v(),...fd(op,0,0,16/width-1)];
  add(`lane-memory-${op}`,op<=87?output(expr):[...expr,...i32(0)],127,width);
}
for (let op=92;op<=93;op++) add(`load-zero-${op}`,output([32,0,...fd(op,0,0)]),127,op===92?4:8);
add("local-block-select",output([2,123,...v(),11,33,1,32,1,...v(b),...i32(1),27]),127,0,[1,1,123]);
add("dead-immediates",[2,64,0,...v(new Array(16).fill(16)),26,11,...i32(0)]);
add("float-nan-bits",output([67,1,0,192,127,...fd(19)]));
add("double-nan-bits",output([68,1,0,0,0,0,0,248,127,...fd(20)]));
// Comparisons and reductions load their operands from memory so LLVM cannot
// fold the lane predicates from the module's constant expressions.
const vectorLoad = (address) => [...i32(address), ...fd(0, 0, 0)];
const comparisons = [...Array.from({ length: 30 }, (_, i) => 0x23 + i), ...Array.from({ length: 6 }, (_, i) => 0xd6 + i)];
for (const op of comparisons) {
  for (const [variant, left, right] of [["mixed", a, b], ["equal", a, a], ["reverse", b, a]]) {
    add(`compare-${op}-${variant}`, output([...vectorLoad(32), ...vectorLoad(48), ...fd(op)]), 127, 0, [0], [...left, ...right]);
  }
}
for (let group = 0; group < 4; group++) {
  for (const op of [0x63 + 0x20 * group, 0x64 + 0x20 * group]) {
    for (const [variant, data] of [["mixed", a], ["zero", new Array(16).fill(0)], ["ones", new Array(16).fill(255)], ["high", [...new Array(15).fill(0), 128]]]) {
      add(`reduce-${op}-${variant}`, [...vectorLoad(32), ...fd(op)], 127, 0, [0], data);
    }
  }
}
// Wraparound, signed minima and negative/multiple-of-width shift counts.
const laneBytes = (bits, values) => {
  const bytes = [];
  for (let lane = 0; lane < 128 / bits; lane++) {
    const value = BigInt.asUintN(bits, values[lane % values.length]);
    for (let byte = 0; byte < bits / 8; byte++) bytes.push(Number((value >> BigInt(8 * byte)) & 255n));
  }
  return bytes;
};
for (let group = 0; group < 4; group++) {
  const bits = 8 << group;
  const min = -(1n << BigInt(bits - 1));
  const max = -min - 1n;
  const left = laneBytes(bits, [min, max, -1n, 0n, 1n, 2n]);
  const right = laneBytes(bits, [-1n, 1n, 2n, min, max, 0n]);
  for (let i = 0; i < 3; i++) {
    const op = 0x6b + 0x20 * group + i;
    add(`shift-${op}`, output([...vectorLoad(32), 32, 0, ...fd(op)]), 127, -1, [0], left);
  }
  for (const op of [0x60 + 0x20 * group, 0x61 + 0x20 * group]) {
    add(`unary-${op}`, output([...vectorLoad(32), ...fd(op)]), 127, 0, [0], left);
  }
  const ops = [0x6e + 0x20 * group, 0x71 + 0x20 * group];
  if (group > 0) ops.push(0x75 + 0x20 * group);
  if (group < 3) for (let i = 0; i < 4; i++) ops.push(0x76 + 0x20 * group + i);
  for (const op of ops) {
    for (const [variant, a, b] of [["edges", left, right], ["reverse", right, left]]) {
      add(`arithmetic-${op}-${variant}`, output([...vectorLoad(32), ...vectorLoad(48), ...fd(op)]), 127, 0, [0], [...a, ...b]);
    }
  }
}
for (let group = 0; group < 3; group++) {
  const bits = 8 << group;
  const min = -(1n << BigInt(bits - 1));
  const max = -min - 1n;
  const left = laneBytes(bits, [min, max, -1n, 0n, 1n, 2n]);
  const right = laneBytes(bits, [-1n, 1n, 2n, min, max, 0n]);
  for (let i = 0; i < 4; i++) {
    const extend = 0x87 + 0x20 * group + i;
    add(`extend-${extend}`, output([...vectorLoad(32), ...fd(extend)]), 127, 0, [0], left);
    const multiply = 0x9c + 0x20 * group + i;
    add(`extmul-${multiply}`, output([...vectorLoad(32), ...vectorLoad(48), ...fd(multiply)]), 127, 0, [0], [...left, ...right]);
  }
  if (group < 2) {
    const pairs = laneBytes(bits, [min, min, max, max, -1n, 1n, 0n, 0n]);
    for (let i = 0; i < 2; i++) {
      const op = 0x7c + 2 * group + i;
      add(`pairwise-${op}`, output([...vectorLoad(32), ...fd(op)]), 127, 0, [0], pairs);
    }
  }
}
const dot = laneBytes(16, [-32768n, -32768n, 32767n, 32767n, -1n, 1n, -2n, 3n]);
add("dot-overflow", output([...vectorLoad(32), ...vectorLoad(48), ...fd(0xba)]), 127, 0, [0], [...dot, ...dot]);
// Vector signatures are native-only. Only the scalar wrapper is exported.
const functionType = (params, results) => [96, ...u32(params.length), ...params, ...u32(results.length), ...results];
function vectorModule(label, type, main, inner = null, width = 0) {
  const types = [functionType([127], [127]), type];
  const bodies = [[0, ...main, 11], ...(inner === null ? [] : [[0, ...inner, 11]])];
  const bytes = [0,97,115,109,1,0,0,0,
    ...section(1,[types.length,...types.flat()]),
    ...section(3,[bodies.length,0,...(inner === null ? [] : [1])]),
    ...section(5,[1,0,1]),
    ...section(7,[2,...name("run"),0,0,...name("memory"),2,0]),
    ...section(10,[bodies.length,...bodies.flatMap(body=>[...u32(body.length),...body])]),
    ...section(11,[1,0,...i32(32),11,16,...a])];
  fixtures.push({name:label,base64:Buffer.from(bytes).toString("base64"),width});
}
vectorModule("internal-vector-call", functionType([123],[123]), output([...vectorLoad(32),16,1]), [32,0,...fd(0x61)]);
vectorModule("internal-vector-shift", functionType([127,123],[123]), output([32,0,...vectorLoad(32),16,1]), [32,1,32,0,...fd(0x6b)], -1);
vectorModule("indexed-vector-block", functionType([123],[123]), output([...vectorLoad(32),2,1,...fd(0x61),11]));
vectorModule("internal-vector-multivalue", functionType([123],[127,123]), [...vectorLoad(32),16,1,...fd(11,0,0),...i32(0)], [...i32(0),32,0]);
for (let group = 0; group < 2; group++) {
  const bits = 8 << group, min = -(1n << BigInt(bits - 1)), max = -min - 1n;
  const left = laneBytes(bits, [min,max,-1n,0n,min,max,-1n,1n]);
  const right = laneBytes(bits, [-1n,1n,1n,1n,min,max,-1n,min]);
  for (const op of [0x6f+32*group,0x70+32*group,0x72+32*group,0x73+32*group,0x7b+32*group]) {
    add(`saturating-${op}`, output([...vectorLoad(32),...vectorLoad(48),...fd(op)]),127,0,[0],[...left,...right]);
  }
  const wideLeft = laneBytes(2*bits, group===0?[-32768n,-1n,0n,127n,128n,255n,256n,32767n]:[-2147483648n,-1n,0n,65536n]);
  const wideRight = laneBytes(2*bits, group===0?[32767n,256n,255n,128n,127n,0n,-1n,-32768n]:[2147483647n,65535n,32767n,32768n]);
  for (const op of [0x65+32*group,0x66+32*group]) add(`narrow-${op}`,output([...vectorLoad(32),...vectorLoad(48),...fd(op)]),127,0,[0],[...wideLeft,...wideRight]);
}
const q15a=laneBytes(16,[-32768n,-32768n,32767n,1n,-1n,16384n,-16384n,0n]);
const q15b=laneBytes(16,[-32768n,32767n,32767n,16384n,16384n,16384n,16384n,32767n]);
add("q15-round-and-saturate",output([...vectorLoad(32),...vectorLoad(48),...fd(0x82)]),127,0,[0],[...q15a,...q15b]);
add("popcnt",output([...vectorLoad(32),...fd(0x62)]),127,0,[0],[0,1,2,3,7,15,31,63,127,128,255,170,85,254,192,16]);
const floatSelectionOps = [...Array.from({length:12},(_,i)=>0x41+i),0xe0,0xe1,0xec,0xed,0xea,0xeb,0xf6,0xf7];
const floatBits = (bits, values) => laneBytes(bits, values.map(BigInt));
const fpPatterns = (bits) => bits === 32 ? [
  ["zero", [0,0x80000000], [0x80000000,0]],
  ["nan-left", [0x7fc01234,0x7f801234], [0x3f800000,0xbf800000]],
  ["nan-right", [0x3f800000,0xbf800000], [0xffc01234,0xff801234]],
  ["negative-nan", [0xffc01234,0xff801234], [0x7fc05678,0x7f805678]],
  ["negative-subnormal", [0x80000001,0x807fffff,0x00800000,0x80800000], [1,0x007fffff,0x80800000,0x00800000]],
  ["finite", [1,0x7f7fffff,0x7f800000,0xff800000], [0x80000001,0xff7fffff,0xff800000,0x7f800000]],
] : [
  ["zero", [0n,0x8000000000000000n], [0x8000000000000000n,0n]],
  ["nan-left", [0x7ff8000000001234n,0x7ff0000000001234n], [0x3ff0000000000000n,0xbff0000000000000n]],
  ["nan-right", [0x3ff0000000000000n,0xbff0000000000000n], [0xfff8000000001234n,0xfff0000000001234n]],
  ["negative-nan", [0xfff8000000001234n,0xfff0000000001234n], [0x7ff8000000005678n,0x7ff0000000005678n]],
  ["negative-subnormal", [0x8000000000000001n,0x800fffffffffffffn], [0x0010000000000000n,0x8010000000000000n]],
  ["infinity", [0x7ff0000000000000n,0xfff0000000000000n], [0xfff0000000000000n,0x7ff0000000000000n]],
  ["finite", [1n,0x7fefffffffffffffn], [0x8000000000000001n,0xffefffffffffffffn]],
];
for (const op of floatSelectionOps) {
  const bits = op<=0x4c ? (op<0x47?32:64) : (op<0xec?32:64);
  const unary = [0xe0,0xe1,0xec,0xed].includes(op);
  for (const [variant, left, right] of fpPatterns(bits)) {
    add(`float-select-${op}-${variant}`,output([...vectorLoad(32),...(unary?[]:vectorLoad(48)),...fd(op)]),127,0,[0],[...floatBits(bits,left),...floatBits(bits,right)]);
  }
}
const numberBytes = (bits, values) => {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 128/bits; i++) bits===32 ? bytes.writeFloatLE(values[i%values.length],4*i) : bytes.writeDoubleLE(values[i%values.length],8*i);
  return [...bytes];
};
for (const bits of [32,64]) {
  const base=bits===32?0xe4:0xf0;
  const unary=bits===32?[0x67,0x68,0x69,0x6a,0xe3]:[0x74,0x75,0x7a,0x94,0xef];
  const ops=[...unary,...Array.from({length:6},(_,i)=>base+i)];
  const patterns=[...fpPatterns(bits).map(([name,a,b])=>[name,floatBits(bits,a),floatBits(bits,b)]),
    ["ties",numberBytes(bits,[0.5,-0.5,1.5,-1.5]),numberBytes(bits,[2.5,-2.5,3.5,-3.5])],
    ["ties-one",numberBytes(bits,[1.5,-1.5,2.5,-2.5]),numberBytes(bits,[0,0,0,0])],
    ["negative-ties",numberBytes(bits,[-2.5,-3.5,-0.1,-1.1]),numberBytes(bits,[2,3,4,5])],
    ["large",numberBytes(bits,[2**(bits===32?23:52)-0.5,2**(bits===32?23:52),-(2**(bits===32?23:52)),-0]),numberBytes(bits,[1,0,2,0])]];
  for (const op of ops) for (const [variant,a,b] of patterns) {
    add(`float-math-${op}-${variant}`,output([...vectorLoad(32),...(unary.includes(op)?[]:vectorLoad(48)),...fd(op)]),127,0,[0],[...a,...b],bits);
  }
}
for (const op of [0x5e,0x5f,...Array.from({length:8},(_,i)=>0xf8+i)]) {
  const bits=op===0x5e||op>=0xfc?64:32;
  const fromInteger=op>=0xf8&&(op-0xf8)%4>=2;
  const floatResult=op===0x5e?32:op===0x5f?64:fromInteger?bits:0;
  const data=fromInteger?laneBytes(32,[-2147483648n,2147483647n,-1n,0n]):null;
  const patterns=fromInteger?[["integers",data],["integers-high",laneBytes(32,[-1n,0n,16777217n,-2147483647n])]]:[
    ...fpPatterns(bits).map(([name,a])=>[name,floatBits(bits,a)]),
    ["range",numberBytes(bits,[-2147483648,2147483648,4294967296,-1])],
    ["fraction",numberBytes(bits,[-0.5,0.5,-2147483649,4294967295])],
    ["range-neighbors",numberBytes(bits,[-2147483904,2147483520,4294967040,4294967296])],
    ["precision",numberBytes(bits,[16777217,1.0000000596046448,2**-149,-0])],
  ];
  for (const [variant,data] of patterns) add(`float-convert-${op}-${variant}`,output([...vectorLoad(32),...fd(op)]),127,0,[0],data,floatResult);
}
writeFileSync(new URL("./corpus/simd-data.json",import.meta.url),JSON.stringify(fixtures,null,2)+"\n");
const inputs = fixtures.map((f)=>`  Buffer.from("${f.base64}", "base64"),`).join("\n");
writeFileSync(new URL("../corpus/webassembly-simd-data/main.mjs",import.meta.url),`// Generated by tests/wasm-spec/gen-simd-data.mjs. Each module has scalar exports.\nconst modules = [\n${inputs}\n];\nconst names = ${JSON.stringify(fixtures.map(f=>f.name))};\nconst widths = ${JSON.stringify(fixtures.map(f=>f.width))};\nconst floatOutputs = ${JSON.stringify(fixtures.map(f=>f.floatOutput||0))};\nlet seed = 0x1679;\nfunction randomByte() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; }\nfor (let i = 0; i < modules.length; i++) {\n  const bytes = modules[i];\n  console.log(names[i], WebAssembly.validate(bytes));\n  const module = new WebAssembly.Module(bytes);\n  const addresses = widths[i] < 0 ? [0, 1, 7, 8, 15, 16, 31, 32, 63, 64, 65, 127, 128, -1, -2147483648, 2147483647] : widths[i] > 0 ? [32, 33, 65536 - widths[i], 65537 - widths[i], -1] : [32, 0, -129, 2147483647];\n  for (const address of addresses) {\n    const x = new WebAssembly.Instance(module).exports;\n    try {\n      if (widths[i] === 0 && (address === 0 || address === 2147483647)) {\n        const data = new Uint8Array(x.memory.buffer, 32, 32);\n        for (let byte = 0; byte < data.length; byte++) data[byte] = randomByte();\n      }\n      const result = x.run(address);
      const bits = floatOutputs[i];
      if (bits) {
        const words = new Uint32Array(x.memory.buffer, 0, 4);
        for (let lane = 0; lane < 128 / bits; lane++) {
          const highIndex = bits === 32 ? lane : 2 * lane + 1;
          const high = words[highIndex];
          const exponent = bits === 32 ? 0x7f800000 : 0x7ff00000;
          const fraction = bits === 32 ? 0x007fffff : 0x000fffff;
          if ((high & exponent) === exponent && ((high & fraction) !== 0 || (bits === 64 && words[2 * lane] !== 0))) {
            if ((high & (bits === 32 ? 0x00400000 : 0x00080000)) === 0) throw new Error("Signaling NaN arithmetic result");
            words[highIndex] = bits === 32 ? 0x7fc00000 : 0x7ff80000;
            if (bits === 64) words[2 * lane] = 0;
          }
        }
      }
      console.log(address, String(result), new Uint8Array(x.memory.buffer, 0, 64).join(","));\n    } catch (error) {\n      console.log(address, error.name, error.message, new Uint8Array(x.memory.buffer, 65504, 32).join(","));\n    }\n  }\n}\n`);
console.log(`Generated ${fixtures.length} SIMD modules`);
