/* The WebAssembly SIMD instruction table: every 0xfd subopcode of the
 * 128-bit SIMD proposal, including the 20 relaxed-SIMD instructions, with its
 * stack signature and immediates. binary.ts types function bodies with it;
 * translate.ts maps the same entries to LLVM. One table keeps validation and
 * translation agreeing on which opcodes exist and what they do.
 *
 * A row is [subopcode, params, results, immediate, lanes, memory]:
 *   params/results: value-type letters, "V" 128-bit vector, "i" i32,
 *     "L" i64, "f" f32, "D" f64 (the runtime's signature letters).
 *   immediate: 0 none, 1 v128.const (16 bytes), 2 i8x16.shuffle (16 lane
 *     bytes, each below 32), 3 a lane index, 4 a memarg, 5 a memarg and a
 *     lane index.
 *   lanes: the lane count the lane index must be below (0 when none).
 *   memory: the bytes a memory access reads or writes (0 for none), which
 *     is also its natural alignment.
 *
 * The gaps in the subopcode space (0x9a, 0xa2, ...) are absent and are
 * malformed. Plain TypeScript, so the native compiler compiles it too. */

/** One SIMD instruction's encoding. */
export interface SimdOp {
  params: readonly number[];
  results: readonly number[];
  immediate: number;
  lanes: number;
  memory: number;
}

const V = 0x7b;
const I = 0x7f;
const L = 0x7e;
const F = 0x7d;
const D = 0x7c;

function types(letters: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < letters.length; i++) {
    const c = letters[i];
    out.push(c === "V" ? V : c === "i" ? I : c === "L" ? L : c === "f" ? F : D);
  }
  return out;
}

const ROWS: readonly (readonly [number, string, string, number, number, number])[] = [
  [0, "i", "V", 4, 0, 16], // v128.load
  [1, "i", "V", 4, 0, 8], // v128.load8x8_s
  [2, "i", "V", 4, 0, 8], // v128.load8x8_u
  [3, "i", "V", 4, 0, 8], // v128.load16x4_s
  [4, "i", "V", 4, 0, 8], // v128.load16x4_u
  [5, "i", "V", 4, 0, 8], // v128.load32x2_s
  [6, "i", "V", 4, 0, 8], // v128.load32x2_u
  [7, "i", "V", 4, 0, 1], // v128.load8_splat
  [8, "i", "V", 4, 0, 2], // v128.load16_splat
  [9, "i", "V", 4, 0, 4], // v128.load32_splat
  [10, "i", "V", 4, 0, 8], // v128.load64_splat
  [11, "iV", "", 4, 0, 16], // v128.store
  [12, "", "V", 1, 0, 0], // v128.const
  [13, "VV", "V", 2, 0, 0], // i8x16.shuffle
  [14, "VV", "V", 0, 0, 0], // i8x16.swizzle
  [15, "i", "V", 0, 0, 0], // i8x16.splat
  [16, "i", "V", 0, 0, 0], // i16x8.splat
  [17, "i", "V", 0, 0, 0], // i32x4.splat
  [18, "L", "V", 0, 0, 0], // i64x2.splat
  [19, "f", "V", 0, 0, 0], // f32x4.splat
  [20, "D", "V", 0, 0, 0], // f64x2.splat
  [21, "V", "i", 3, 16, 0], // i8x16.extract_lane_s
  [22, "V", "i", 3, 16, 0], // i8x16.extract_lane_u
  [23, "Vi", "V", 3, 16, 0], // i8x16.replace_lane
  [24, "V", "i", 3, 8, 0], // i16x8.extract_lane_s
  [25, "V", "i", 3, 8, 0], // i16x8.extract_lane_u
  [26, "Vi", "V", 3, 8, 0], // i16x8.replace_lane
  [27, "V", "i", 3, 4, 0], // i32x4.extract_lane
  [28, "Vi", "V", 3, 4, 0], // i32x4.replace_lane
  [29, "V", "L", 3, 2, 0], // i64x2.extract_lane
  [30, "VL", "V", 3, 2, 0], // i64x2.replace_lane
  [31, "V", "f", 3, 4, 0], // f32x4.extract_lane
  [32, "Vf", "V", 3, 4, 0], // f32x4.replace_lane
  [33, "V", "D", 3, 2, 0], // f64x2.extract_lane
  [34, "VD", "V", 3, 2, 0], // f64x2.replace_lane
  [35, "VV", "V", 0, 0, 0], // i8x16.eq
  [36, "VV", "V", 0, 0, 0], // i8x16.ne
  [37, "VV", "V", 0, 0, 0], // i8x16.lt_s
  [38, "VV", "V", 0, 0, 0], // i8x16.lt_u
  [39, "VV", "V", 0, 0, 0], // i8x16.gt_s
  [40, "VV", "V", 0, 0, 0], // i8x16.gt_u
  [41, "VV", "V", 0, 0, 0], // i8x16.le_s
  [42, "VV", "V", 0, 0, 0], // i8x16.le_u
  [43, "VV", "V", 0, 0, 0], // i8x16.ge_s
  [44, "VV", "V", 0, 0, 0], // i8x16.ge_u
  [45, "VV", "V", 0, 0, 0], // i16x8.eq
  [46, "VV", "V", 0, 0, 0], // i16x8.ne
  [47, "VV", "V", 0, 0, 0], // i16x8.lt_s
  [48, "VV", "V", 0, 0, 0], // i16x8.lt_u
  [49, "VV", "V", 0, 0, 0], // i16x8.gt_s
  [50, "VV", "V", 0, 0, 0], // i16x8.gt_u
  [51, "VV", "V", 0, 0, 0], // i16x8.le_s
  [52, "VV", "V", 0, 0, 0], // i16x8.le_u
  [53, "VV", "V", 0, 0, 0], // i16x8.ge_s
  [54, "VV", "V", 0, 0, 0], // i16x8.ge_u
  [55, "VV", "V", 0, 0, 0], // i32x4.eq
  [56, "VV", "V", 0, 0, 0], // i32x4.ne
  [57, "VV", "V", 0, 0, 0], // i32x4.lt_s
  [58, "VV", "V", 0, 0, 0], // i32x4.lt_u
  [59, "VV", "V", 0, 0, 0], // i32x4.gt_s
  [60, "VV", "V", 0, 0, 0], // i32x4.gt_u
  [61, "VV", "V", 0, 0, 0], // i32x4.le_s
  [62, "VV", "V", 0, 0, 0], // i32x4.le_u
  [63, "VV", "V", 0, 0, 0], // i32x4.ge_s
  [64, "VV", "V", 0, 0, 0], // i32x4.ge_u
  [65, "VV", "V", 0, 0, 0], // f32x4.eq
  [66, "VV", "V", 0, 0, 0], // f32x4.ne
  [67, "VV", "V", 0, 0, 0], // f32x4.lt
  [68, "VV", "V", 0, 0, 0], // f32x4.gt
  [69, "VV", "V", 0, 0, 0], // f32x4.le
  [70, "VV", "V", 0, 0, 0], // f32x4.ge
  [71, "VV", "V", 0, 0, 0], // f64x2.eq
  [72, "VV", "V", 0, 0, 0], // f64x2.ne
  [73, "VV", "V", 0, 0, 0], // f64x2.lt
  [74, "VV", "V", 0, 0, 0], // f64x2.gt
  [75, "VV", "V", 0, 0, 0], // f64x2.le
  [76, "VV", "V", 0, 0, 0], // f64x2.ge
  [77, "V", "V", 0, 0, 0], // v128.not
  [78, "VV", "V", 0, 0, 0], // v128.and
  [79, "VV", "V", 0, 0, 0], // v128.andnot
  [80, "VV", "V", 0, 0, 0], // v128.or
  [81, "VV", "V", 0, 0, 0], // v128.xor
  [82, "VVV", "V", 0, 0, 0], // v128.bitselect
  [83, "V", "i", 0, 0, 0], // v128.any_true
  [84, "iV", "V", 5, 16, 1], // v128.load8_lane
  [85, "iV", "V", 5, 8, 2], // v128.load16_lane
  [86, "iV", "V", 5, 4, 4], // v128.load32_lane
  [87, "iV", "V", 5, 2, 8], // v128.load64_lane
  [88, "iV", "", 5, 16, 1], // v128.store8_lane
  [89, "iV", "", 5, 8, 2], // v128.store16_lane
  [90, "iV", "", 5, 4, 4], // v128.store32_lane
  [91, "iV", "", 5, 2, 8], // v128.store64_lane
  [92, "i", "V", 4, 0, 4], // v128.load32_zero
  [93, "i", "V", 4, 0, 8], // v128.load64_zero
  [94, "V", "V", 0, 0, 0], // f32x4.demote_f64x2_zero
  [95, "V", "V", 0, 0, 0], // f64x2.promote_low_f32x4
  [96, "V", "V", 0, 0, 0], // i8x16.abs
  [97, "V", "V", 0, 0, 0], // i8x16.neg
  [98, "V", "V", 0, 0, 0], // i8x16.popcnt
  [99, "V", "i", 0, 0, 0], // i8x16.all_true
  [100, "V", "i", 0, 0, 0], // i8x16.bitmask
  [101, "VV", "V", 0, 0, 0], // i8x16.narrow_i16x8_s
  [102, "VV", "V", 0, 0, 0], // i8x16.narrow_i16x8_u
  [103, "V", "V", 0, 0, 0], // f32x4.ceil
  [104, "V", "V", 0, 0, 0], // f32x4.floor
  [105, "V", "V", 0, 0, 0], // f32x4.trunc
  [106, "V", "V", 0, 0, 0], // f32x4.nearest
  [107, "Vi", "V", 0, 0, 0], // i8x16.shl
  [108, "Vi", "V", 0, 0, 0], // i8x16.shr_s
  [109, "Vi", "V", 0, 0, 0], // i8x16.shr_u
  [110, "VV", "V", 0, 0, 0], // i8x16.add
  [111, "VV", "V", 0, 0, 0], // i8x16.add_sat_s
  [112, "VV", "V", 0, 0, 0], // i8x16.add_sat_u
  [113, "VV", "V", 0, 0, 0], // i8x16.sub
  [114, "VV", "V", 0, 0, 0], // i8x16.sub_sat_s
  [115, "VV", "V", 0, 0, 0], // i8x16.sub_sat_u
  [116, "V", "V", 0, 0, 0], // f64x2.ceil
  [117, "V", "V", 0, 0, 0], // f64x2.floor
  [118, "VV", "V", 0, 0, 0], // i8x16.min_s
  [119, "VV", "V", 0, 0, 0], // i8x16.min_u
  [120, "VV", "V", 0, 0, 0], // i8x16.max_s
  [121, "VV", "V", 0, 0, 0], // i8x16.max_u
  [122, "V", "V", 0, 0, 0], // f64x2.trunc
  [123, "VV", "V", 0, 0, 0], // i8x16.avgr_u
  [124, "V", "V", 0, 0, 0], // i16x8.extadd_pairwise_i8x16_s
  [125, "V", "V", 0, 0, 0], // i16x8.extadd_pairwise_i8x16_u
  [126, "V", "V", 0, 0, 0], // i32x4.extadd_pairwise_i16x8_s
  [127, "V", "V", 0, 0, 0], // i32x4.extadd_pairwise_i16x8_u
  [128, "V", "V", 0, 0, 0], // i16x8.abs
  [129, "V", "V", 0, 0, 0], // i16x8.neg
  [130, "VV", "V", 0, 0, 0], // i16x8.q15mulr_sat_s
  [131, "V", "i", 0, 0, 0], // i16x8.all_true
  [132, "V", "i", 0, 0, 0], // i16x8.bitmask
  [133, "VV", "V", 0, 0, 0], // i16x8.narrow_i32x4_s
  [134, "VV", "V", 0, 0, 0], // i16x8.narrow_i32x4_u
  [135, "V", "V", 0, 0, 0], // i16x8.extend_low_i8x16_s
  [136, "V", "V", 0, 0, 0], // i16x8.extend_high_i8x16_s
  [137, "V", "V", 0, 0, 0], // i16x8.extend_low_i8x16_u
  [138, "V", "V", 0, 0, 0], // i16x8.extend_high_i8x16_u
  [139, "Vi", "V", 0, 0, 0], // i16x8.shl
  [140, "Vi", "V", 0, 0, 0], // i16x8.shr_s
  [141, "Vi", "V", 0, 0, 0], // i16x8.shr_u
  [142, "VV", "V", 0, 0, 0], // i16x8.add
  [143, "VV", "V", 0, 0, 0], // i16x8.add_sat_s
  [144, "VV", "V", 0, 0, 0], // i16x8.add_sat_u
  [145, "VV", "V", 0, 0, 0], // i16x8.sub
  [146, "VV", "V", 0, 0, 0], // i16x8.sub_sat_s
  [147, "VV", "V", 0, 0, 0], // i16x8.sub_sat_u
  [148, "V", "V", 0, 0, 0], // f64x2.nearest
  [149, "VV", "V", 0, 0, 0], // i16x8.mul
  [150, "VV", "V", 0, 0, 0], // i16x8.min_s
  [151, "VV", "V", 0, 0, 0], // i16x8.min_u
  [152, "VV", "V", 0, 0, 0], // i16x8.max_s
  [153, "VV", "V", 0, 0, 0], // i16x8.max_u
  [155, "VV", "V", 0, 0, 0], // i16x8.avgr_u
  [156, "VV", "V", 0, 0, 0], // i16x8.extmul_low_i8x16_s
  [157, "VV", "V", 0, 0, 0], // i16x8.extmul_high_i8x16_s
  [158, "VV", "V", 0, 0, 0], // i16x8.extmul_low_i8x16_u
  [159, "VV", "V", 0, 0, 0], // i16x8.extmul_high_i8x16_u
  [160, "V", "V", 0, 0, 0], // i32x4.abs
  [161, "V", "V", 0, 0, 0], // i32x4.neg
  [163, "V", "i", 0, 0, 0], // i32x4.all_true
  [164, "V", "i", 0, 0, 0], // i32x4.bitmask
  [167, "V", "V", 0, 0, 0], // i32x4.extend_low_i16x8_s
  [168, "V", "V", 0, 0, 0], // i32x4.extend_high_i16x8_s
  [169, "V", "V", 0, 0, 0], // i32x4.extend_low_i16x8_u
  [170, "V", "V", 0, 0, 0], // i32x4.extend_high_i16x8_u
  [171, "Vi", "V", 0, 0, 0], // i32x4.shl
  [172, "Vi", "V", 0, 0, 0], // i32x4.shr_s
  [173, "Vi", "V", 0, 0, 0], // i32x4.shr_u
  [174, "VV", "V", 0, 0, 0], // i32x4.add
  [177, "VV", "V", 0, 0, 0], // i32x4.sub
  [181, "VV", "V", 0, 0, 0], // i32x4.mul
  [182, "VV", "V", 0, 0, 0], // i32x4.min_s
  [183, "VV", "V", 0, 0, 0], // i32x4.min_u
  [184, "VV", "V", 0, 0, 0], // i32x4.max_s
  [185, "VV", "V", 0, 0, 0], // i32x4.max_u
  [186, "VV", "V", 0, 0, 0], // i32x4.dot_i16x8_s
  [188, "VV", "V", 0, 0, 0], // i32x4.extmul_low_i16x8_s
  [189, "VV", "V", 0, 0, 0], // i32x4.extmul_high_i16x8_s
  [190, "VV", "V", 0, 0, 0], // i32x4.extmul_low_i16x8_u
  [191, "VV", "V", 0, 0, 0], // i32x4.extmul_high_i16x8_u
  [192, "V", "V", 0, 0, 0], // i64x2.abs
  [193, "V", "V", 0, 0, 0], // i64x2.neg
  [195, "V", "i", 0, 0, 0], // i64x2.all_true
  [196, "V", "i", 0, 0, 0], // i64x2.bitmask
  [199, "V", "V", 0, 0, 0], // i64x2.extend_low_i32x4_s
  [200, "V", "V", 0, 0, 0], // i64x2.extend_high_i32x4_s
  [201, "V", "V", 0, 0, 0], // i64x2.extend_low_i32x4_u
  [202, "V", "V", 0, 0, 0], // i64x2.extend_high_i32x4_u
  [203, "Vi", "V", 0, 0, 0], // i64x2.shl
  [204, "Vi", "V", 0, 0, 0], // i64x2.shr_s
  [205, "Vi", "V", 0, 0, 0], // i64x2.shr_u
  [206, "VV", "V", 0, 0, 0], // i64x2.add
  [209, "VV", "V", 0, 0, 0], // i64x2.sub
  [213, "VV", "V", 0, 0, 0], // i64x2.mul
  [214, "VV", "V", 0, 0, 0], // i64x2.eq
  [215, "VV", "V", 0, 0, 0], // i64x2.ne
  [216, "VV", "V", 0, 0, 0], // i64x2.lt_s
  [217, "VV", "V", 0, 0, 0], // i64x2.gt_s
  [218, "VV", "V", 0, 0, 0], // i64x2.le_s
  [219, "VV", "V", 0, 0, 0], // i64x2.ge_s
  [220, "VV", "V", 0, 0, 0], // i64x2.extmul_low_i32x4_s
  [221, "VV", "V", 0, 0, 0], // i64x2.extmul_high_i32x4_s
  [222, "VV", "V", 0, 0, 0], // i64x2.extmul_low_i32x4_u
  [223, "VV", "V", 0, 0, 0], // i64x2.extmul_high_i32x4_u
  [224, "V", "V", 0, 0, 0], // f32x4.abs
  [225, "V", "V", 0, 0, 0], // f32x4.neg
  [227, "V", "V", 0, 0, 0], // f32x4.sqrt
  [228, "VV", "V", 0, 0, 0], // f32x4.add
  [229, "VV", "V", 0, 0, 0], // f32x4.sub
  [230, "VV", "V", 0, 0, 0], // f32x4.mul
  [231, "VV", "V", 0, 0, 0], // f32x4.div
  [232, "VV", "V", 0, 0, 0], // f32x4.min
  [233, "VV", "V", 0, 0, 0], // f32x4.max
  [234, "VV", "V", 0, 0, 0], // f32x4.pmin
  [235, "VV", "V", 0, 0, 0], // f32x4.pmax
  [236, "V", "V", 0, 0, 0], // f64x2.abs
  [237, "V", "V", 0, 0, 0], // f64x2.neg
  [239, "V", "V", 0, 0, 0], // f64x2.sqrt
  [240, "VV", "V", 0, 0, 0], // f64x2.add
  [241, "VV", "V", 0, 0, 0], // f64x2.sub
  [242, "VV", "V", 0, 0, 0], // f64x2.mul
  [243, "VV", "V", 0, 0, 0], // f64x2.div
  [244, "VV", "V", 0, 0, 0], // f64x2.min
  [245, "VV", "V", 0, 0, 0], // f64x2.max
  [246, "VV", "V", 0, 0, 0], // f64x2.pmin
  [247, "VV", "V", 0, 0, 0], // f64x2.pmax
  [248, "V", "V", 0, 0, 0], // i32x4.trunc_sat_f32x4_s
  [249, "V", "V", 0, 0, 0], // i32x4.trunc_sat_f32x4_u
  [250, "V", "V", 0, 0, 0], // f32x4.convert_i32x4_s
  [251, "V", "V", 0, 0, 0], // f32x4.convert_i32x4_u
  [252, "V", "V", 0, 0, 0], // i32x4.trunc_sat_f64x2_s_zero
  [253, "V", "V", 0, 0, 0], // i32x4.trunc_sat_f64x2_u_zero
  [254, "V", "V", 0, 0, 0], // f64x2.convert_low_i32x4_s
  [255, "V", "V", 0, 0, 0], // f64x2.convert_low_i32x4_u
  [256, "VV", "V", 0, 0, 0], // i8x16.relaxed_swizzle
  [257, "V", "V", 0, 0, 0], // i32x4.relaxed_trunc_f32x4_s
  [258, "V", "V", 0, 0, 0], // i32x4.relaxed_trunc_f32x4_u
  [259, "V", "V", 0, 0, 0], // i32x4.relaxed_trunc_f64x2_s_zero
  [260, "V", "V", 0, 0, 0], // i32x4.relaxed_trunc_f64x2_u_zero
  [261, "VVV", "V", 0, 0, 0], // f32x4.relaxed_madd
  [262, "VVV", "V", 0, 0, 0], // f32x4.relaxed_nmadd
  [263, "VVV", "V", 0, 0, 0], // f64x2.relaxed_madd
  [264, "VVV", "V", 0, 0, 0], // f64x2.relaxed_nmadd
  [265, "VVV", "V", 0, 0, 0], // i8x16.relaxed_laneselect
  [266, "VVV", "V", 0, 0, 0], // i16x8.relaxed_laneselect
  [267, "VVV", "V", 0, 0, 0], // i32x4.relaxed_laneselect
  [268, "VVV", "V", 0, 0, 0], // i64x2.relaxed_laneselect
  [269, "VV", "V", 0, 0, 0], // f32x4.relaxed_min
  [270, "VV", "V", 0, 0, 0], // f32x4.relaxed_max
  [271, "VV", "V", 0, 0, 0], // f64x2.relaxed_min
  [272, "VV", "V", 0, 0, 0], // f64x2.relaxed_max
  [273, "VV", "V", 0, 0, 0], // i16x8.relaxed_q15mulr_s
  [274, "VV", "V", 0, 0, 0], // i16x8.relaxed_dot_i8x16_i7x16_s
  [275, "VVV", "V", 0, 0, 0], // i32x4.relaxed_dot_i8x16_i7x16_add_s
];

const TABLE: (SimdOp | undefined)[] = [];
for (const [sub, params, results, immediate, lanes, memory] of ROWS) {
  TABLE[sub] = {
    params: types(params),
    results: types(results),
    immediate,
    lanes,
    memory,
  };
}

/** The instruction of subopcode `sub`, or undefined when the encoding is
 * illegal. */
export function simdOp(sub: number): SimdOp | undefined {
  return sub < TABLE.length ? TABLE[sub] : undefined;
}
