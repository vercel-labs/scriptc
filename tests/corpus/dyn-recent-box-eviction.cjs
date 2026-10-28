"use strict";
// Literal strings and top-level functions flowing into checked-dynamic
// values: more of each than the runtime's recent-box slots, so boxes are
// evicted while values still hold them, and reused after.
const words = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "w11", "w12", "w13", "w14", "w15", "w16", "w17", "w18", "w19", "w20", "w21", "w22", "w23", "w24", "w25", "w26", "w27", "w28", "w29", "w30", "w31", "w32", "w33", "w34", "w35", "w36", "w37", "w38", "w39", "w40", "w41", "w42", "w43", "w44", "w45", "w46", "w47", "w48", "w49", "w50", "w51", "w52", "w53", "w54", "w55", "w56", "w57", "w58", "w59", "w60", "w61", "w62", "w63", "w64", "w65", "w66", "w67", "w68", "w69", "w70", "w71", "w72", "w73", "w74", "w75", "w76", "w77", "w78", "w79", "w80", "w81", "w82", "w83", "w84", "w85", "w86", "w87", "w88", "w89", "w90", "w91", "w92", "w93", "w94", "w95", "w96", "w97", "w98", "w99", "w100", "w101", "w102", "w103", "w104", "w105", "w106", "w107", "w108", "w109", "w110", "w111", "w112", "w113", "w114", "w115", "w116", "w117", "w118", "w119", "w120", "w121", "w122", "w123", "w124", "w125", "w126", "w127", "w128", "w129", "w130", "w131", "w132", "w133", "w134", "w135", "w136", "w137", "w138", "w139", "w140", "w141", "w142", "w143", "w144", "w145", "w146", "w147", "w148", "w149", "w150", "w151", "w152", "w153", "w154", "w155", "w156", "w157", "w158", "w159", "w160", "w161", "w162", "w163", "w164", "w165", "w166", "w167", "w168", "w169", "w170", "w171", "w172", "w173", "w174", "w175", "w176", "w177", "w178", "w179", "w180", "w181", "w182", "w183", "w184", "w185", "w186", "w187", "w188", "w189", "w190", "w191", "w192", "w193", "w194", "w195", "w196", "w197", "w198", "w199", "w200", "w201", "w202", "w203", "w204", "w205", "w206", "w207", "w208", "w209", "w210", "w211", "w212", "w213", "w214", "w215", "w216", "w217", "w218", "w219", "w220", "w221", "w222", "w223", "w224", "w225", "w226", "w227", "w228", "w229", "w230", "w231", "w232", "w233", "w234", "w235", "w236", "w237", "w238", "w239", "w240", "w241", "w242", "w243", "w244", "w245", "w246", "w247", "w248", "w249", "w250", "w251", "w252", "w253", "w254", "w255", "w256", "w257", "w258", "w259", "w260", "w261", "w262", "w263", "w264", "w265", "w266", "w267", "w268", "w269", "w270", "w271", "w272", "w273", "w274", "w275", "w276", "w277", "w278", "w279", "w280", "w281", "w282", "w283", "w284", "w285", "w286", "w287", "w288", "w289", "w290", "w291", "w292", "w293", "w294", "w295", "w296", "w297", "w298", "w299"];
function f0(x) { return x + 0; }
function f1(x) { return x + 1; }
function f2(x) { return x + 2; }
function f3(x) { return x + 3; }
function f4(x) { return x + 4; }
function f5(x) { return x + 5; }
function f6(x) { return x + 6; }
function f7(x) { return x + 7; }
function f8(x) { return x + 8; }
function f9(x) { return x + 9; }
function f10(x) { return x + 10; }
function f11(x) { return x + 11; }
function f12(x) { return x + 12; }
function f13(x) { return x + 13; }
function f14(x) { return x + 14; }
function f15(x) { return x + 15; }
function f16(x) { return x + 16; }
function f17(x) { return x + 17; }
function f18(x) { return x + 18; }
function f19(x) { return x + 19; }
function f20(x) { return x + 20; }
function f21(x) { return x + 21; }
function f22(x) { return x + 22; }
function f23(x) { return x + 23; }
function f24(x) { return x + 24; }
function f25(x) { return x + 25; }
function f26(x) { return x + 26; }
function f27(x) { return x + 27; }
function f28(x) { return x + 28; }
function f29(x) { return x + 29; }
function f30(x) { return x + 30; }
function f31(x) { return x + 31; }
function f32(x) { return x + 32; }
function f33(x) { return x + 33; }
function f34(x) { return x + 34; }
function f35(x) { return x + 35; }
function f36(x) { return x + 36; }
function f37(x) { return x + 37; }
function f38(x) { return x + 38; }
function f39(x) { return x + 39; }
function f40(x) { return x + 40; }
function f41(x) { return x + 41; }
function f42(x) { return x + 42; }
function f43(x) { return x + 43; }
function f44(x) { return x + 44; }
function f45(x) { return x + 45; }
function f46(x) { return x + 46; }
function f47(x) { return x + 47; }
function f48(x) { return x + 48; }
function f49(x) { return x + 49; }
function f50(x) { return x + 50; }
function f51(x) { return x + 51; }
function f52(x) { return x + 52; }
function f53(x) { return x + 53; }
function f54(x) { return x + 54; }
function f55(x) { return x + 55; }
function f56(x) { return x + 56; }
function f57(x) { return x + 57; }
function f58(x) { return x + 58; }
function f59(x) { return x + 59; }
function f60(x) { return x + 60; }
function f61(x) { return x + 61; }
function f62(x) { return x + 62; }
function f63(x) { return x + 63; }
function f64(x) { return x + 64; }
function f65(x) { return x + 65; }
function f66(x) { return x + 66; }
function f67(x) { return x + 67; }
function f68(x) { return x + 68; }
function f69(x) { return x + 69; }
function f70(x) { return x + 70; }
function f71(x) { return x + 71; }
function f72(x) { return x + 72; }
function f73(x) { return x + 73; }
function f74(x) { return x + 74; }
function f75(x) { return x + 75; }
function f76(x) { return x + 76; }
function f77(x) { return x + 77; }
function f78(x) { return x + 78; }
function f79(x) { return x + 79; }
function f80(x) { return x + 80; }
function f81(x) { return x + 81; }
function f82(x) { return x + 82; }
function f83(x) { return x + 83; }
function f84(x) { return x + 84; }
function f85(x) { return x + 85; }
function f86(x) { return x + 86; }
function f87(x) { return x + 87; }
function f88(x) { return x + 88; }
function f89(x) { return x + 89; }
function f90(x) { return x + 90; }
function f91(x) { return x + 91; }
function f92(x) { return x + 92; }
function f93(x) { return x + 93; }
function f94(x) { return x + 94; }
function f95(x) { return x + 95; }
function f96(x) { return x + 96; }
function f97(x) { return x + 97; }
function f98(x) { return x + 98; }
function f99(x) { return x + 99; }
function f100(x) { return x + 100; }
function f101(x) { return x + 101; }
function f102(x) { return x + 102; }
function f103(x) { return x + 103; }
function f104(x) { return x + 104; }
function f105(x) { return x + 105; }
function f106(x) { return x + 106; }
function f107(x) { return x + 107; }
function f108(x) { return x + 108; }
function f109(x) { return x + 109; }
function f110(x) { return x + 110; }
function f111(x) { return x + 111; }
function f112(x) { return x + 112; }
function f113(x) { return x + 113; }
function f114(x) { return x + 114; }
function f115(x) { return x + 115; }
function f116(x) { return x + 116; }
function f117(x) { return x + 117; }
function f118(x) { return x + 118; }
function f119(x) { return x + 119; }
function f120(x) { return x + 120; }
function f121(x) { return x + 121; }
function f122(x) { return x + 122; }
function f123(x) { return x + 123; }
function f124(x) { return x + 124; }
function f125(x) { return x + 125; }
function f126(x) { return x + 126; }
function f127(x) { return x + 127; }
function f128(x) { return x + 128; }
function f129(x) { return x + 129; }
function f130(x) { return x + 130; }
function f131(x) { return x + 131; }
function f132(x) { return x + 132; }
function f133(x) { return x + 133; }
function f134(x) { return x + 134; }
function f135(x) { return x + 135; }
function f136(x) { return x + 136; }
function f137(x) { return x + 137; }
function f138(x) { return x + 138; }
function f139(x) { return x + 139; }
const table = { f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20, f21, f22, f23, f24, f25, f26, f27, f28, f29, f30, f31, f32, f33, f34, f35, f36, f37, f38, f39, f40, f41, f42, f43, f44, f45, f46, f47, f48, f49, f50, f51, f52, f53, f54, f55, f56, f57, f58, f59, f60, f61, f62, f63, f64, f65, f66, f67, f68, f69, f70, f71, f72, f73, f74, f75, f76, f77, f78, f79, f80, f81, f82, f83, f84, f85, f86, f87, f88, f89, f90, f91, f92, f93, f94, f95, f96, f97, f98, f99, f100, f101, f102, f103, f104, f105, f106, f107, f108, f109, f110, f111, f112, f113, f114, f115, f116, f117, f118, f119, f120, f121, f122, f123, f124, f125, f126, f127, f128, f129, f130, f131, f132, f133, f134, f135, f136, f137, f138, f139 };

const held = [];
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < words.length; i++) held.push({ word: words[i], round });
}
const kept = [];
let total = 0;
for (let round = 0; round < 3; round++) {
  for (const name of Object.keys(table)) {
    const box = { fn: table[name] };
    if (round === 0) kept.push(box);
    total += box.fn(round);
  }
}
console.log(held.length, held[0].word, held[299].word, held[300].word, held[899].word);
console.log(held.filter((h) => h.word === "w42").length, total);
console.log(kept.length, kept[7].fn === f7, kept[139].fn(1), typeof kept[139].fn);
