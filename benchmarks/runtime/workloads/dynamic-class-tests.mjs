// Untyped JavaScript in a program with many classes, testing and making
// values through constructors it holds in variables: `value instanceof
// ctor` against class values and against builtin constructors, `new ctor()`
// from a list of classes, and deep copies of plain records whose guards ask
// the builtin constructors and whose members are read by computed keys.
// None of that depends on how many classes the program declares, so the
// time must not either: the 240 classes below are there to show it if a
// dispatch over the program's classes becomes a walk again. Argument: the
// number of rounds.
const rounds = Number(process.argv[2] ?? "100000");
class Part {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size;
  }
}
class K0 extends Part {
  weight() {
    return this.size + 0;
  }
}
class K1 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 1;
  }
}
class K2 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 2;
  }
}
class K3 extends Part {
  weight() {
    return this.size + 3;
  }
}
class K4 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 4;
  }
}
class K5 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 5;
  }
}
class K6 extends Part {
  weight() {
    return this.size + 6;
  }
}
class K7 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 7;
  }
}
class K8 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 8;
  }
}
class K9 extends Part {
  weight() {
    return this.size + 9;
  }
}
class K10 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 10;
  }
}
class K11 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 11;
  }
}
class K12 extends Part {
  weight() {
    return this.size + 12;
  }
}
class K13 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 13;
  }
}
class K14 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 14;
  }
}
class K15 extends Part {
  weight() {
    return this.size + 15;
  }
}
class K16 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 16;
  }
}
class K17 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 17;
  }
}
class K18 extends Part {
  weight() {
    return this.size + 18;
  }
}
class K19 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 19;
  }
}
class K20 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 20;
  }
}
class K21 extends Part {
  weight() {
    return this.size + 21;
  }
}
class K22 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 22;
  }
}
class K23 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 23;
  }
}
class K24 extends Part {
  weight() {
    return this.size + 24;
  }
}
class K25 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 25;
  }
}
class K26 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 26;
  }
}
class K27 extends Part {
  weight() {
    return this.size + 27;
  }
}
class K28 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 28;
  }
}
class K29 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 29;
  }
}
class K30 extends Part {
  weight() {
    return this.size + 30;
  }
}
class K31 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 31;
  }
}
class K32 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 32;
  }
}
class K33 extends Part {
  weight() {
    return this.size + 33;
  }
}
class K34 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 34;
  }
}
class K35 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 35;
  }
}
class K36 extends Part {
  weight() {
    return this.size + 36;
  }
}
class K37 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 37;
  }
}
class K38 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 38;
  }
}
class K39 extends Part {
  weight() {
    return this.size + 39;
  }
}
class K40 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 40;
  }
}
class K41 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 41;
  }
}
class K42 extends Part {
  weight() {
    return this.size + 42;
  }
}
class K43 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 43;
  }
}
class K44 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 44;
  }
}
class K45 extends Part {
  weight() {
    return this.size + 45;
  }
}
class K46 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 46;
  }
}
class K47 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 47;
  }
}
class K48 extends Part {
  weight() {
    return this.size + 48;
  }
}
class K49 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 49;
  }
}
class K50 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 50;
  }
}
class K51 extends Part {
  weight() {
    return this.size + 51;
  }
}
class K52 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 52;
  }
}
class K53 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 53;
  }
}
class K54 extends Part {
  weight() {
    return this.size + 54;
  }
}
class K55 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 55;
  }
}
class K56 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 56;
  }
}
class K57 extends Part {
  weight() {
    return this.size + 57;
  }
}
class K58 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 58;
  }
}
class K59 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 59;
  }
}
class K60 extends Part {
  weight() {
    return this.size + 60;
  }
}
class K61 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 61;
  }
}
class K62 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 62;
  }
}
class K63 extends Part {
  weight() {
    return this.size + 63;
  }
}
class K64 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 64;
  }
}
class K65 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 65;
  }
}
class K66 extends Part {
  weight() {
    return this.size + 66;
  }
}
class K67 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 67;
  }
}
class K68 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 68;
  }
}
class K69 extends Part {
  weight() {
    return this.size + 69;
  }
}
class K70 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 70;
  }
}
class K71 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 71;
  }
}
class K72 extends Part {
  weight() {
    return this.size + 72;
  }
}
class K73 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 73;
  }
}
class K74 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 74;
  }
}
class K75 extends Part {
  weight() {
    return this.size + 75;
  }
}
class K76 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 76;
  }
}
class K77 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 77;
  }
}
class K78 extends Part {
  weight() {
    return this.size + 78;
  }
}
class K79 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 79;
  }
}
class K80 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 80;
  }
}
class K81 extends Part {
  weight() {
    return this.size + 81;
  }
}
class K82 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 82;
  }
}
class K83 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 83;
  }
}
class K84 extends Part {
  weight() {
    return this.size + 84;
  }
}
class K85 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 85;
  }
}
class K86 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 86;
  }
}
class K87 extends Part {
  weight() {
    return this.size + 87;
  }
}
class K88 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 88;
  }
}
class K89 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 89;
  }
}
class K90 extends Part {
  weight() {
    return this.size + 90;
  }
}
class K91 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 91;
  }
}
class K92 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 92;
  }
}
class K93 extends Part {
  weight() {
    return this.size + 93;
  }
}
class K94 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 94;
  }
}
class K95 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 95;
  }
}
class K96 extends Part {
  weight() {
    return this.size + 96;
  }
}
class K97 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 97;
  }
}
class K98 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 98;
  }
}
class K99 extends Part {
  weight() {
    return this.size + 99;
  }
}
class K100 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 100;
  }
}
class K101 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 101;
  }
}
class K102 extends Part {
  weight() {
    return this.size + 102;
  }
}
class K103 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 103;
  }
}
class K104 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 104;
  }
}
class K105 extends Part {
  weight() {
    return this.size + 105;
  }
}
class K106 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 106;
  }
}
class K107 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 107;
  }
}
class K108 extends Part {
  weight() {
    return this.size + 108;
  }
}
class K109 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 109;
  }
}
class K110 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 110;
  }
}
class K111 extends Part {
  weight() {
    return this.size + 111;
  }
}
class K112 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 112;
  }
}
class K113 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 113;
  }
}
class K114 extends Part {
  weight() {
    return this.size + 114;
  }
}
class K115 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 115;
  }
}
class K116 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 116;
  }
}
class K117 extends Part {
  weight() {
    return this.size + 117;
  }
}
class K118 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 118;
  }
}
class K119 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 119;
  }
}
class K120 extends Part {
  weight() {
    return this.size + 120;
  }
}
class K121 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 121;
  }
}
class K122 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 122;
  }
}
class K123 extends Part {
  weight() {
    return this.size + 123;
  }
}
class K124 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 124;
  }
}
class K125 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 125;
  }
}
class K126 extends Part {
  weight() {
    return this.size + 126;
  }
}
class K127 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 127;
  }
}
class K128 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 128;
  }
}
class K129 extends Part {
  weight() {
    return this.size + 129;
  }
}
class K130 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 130;
  }
}
class K131 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 131;
  }
}
class K132 extends Part {
  weight() {
    return this.size + 132;
  }
}
class K133 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 133;
  }
}
class K134 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 134;
  }
}
class K135 extends Part {
  weight() {
    return this.size + 135;
  }
}
class K136 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 136;
  }
}
class K137 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 137;
  }
}
class K138 extends Part {
  weight() {
    return this.size + 138;
  }
}
class K139 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 139;
  }
}
class K140 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 140;
  }
}
class K141 extends Part {
  weight() {
    return this.size + 141;
  }
}
class K142 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 142;
  }
}
class K143 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 143;
  }
}
class K144 extends Part {
  weight() {
    return this.size + 144;
  }
}
class K145 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 145;
  }
}
class K146 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 146;
  }
}
class K147 extends Part {
  weight() {
    return this.size + 147;
  }
}
class K148 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 148;
  }
}
class K149 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 149;
  }
}
class K150 extends Part {
  weight() {
    return this.size + 150;
  }
}
class K151 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 151;
  }
}
class K152 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 152;
  }
}
class K153 extends Part {
  weight() {
    return this.size + 153;
  }
}
class K154 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 154;
  }
}
class K155 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 155;
  }
}
class K156 extends Part {
  weight() {
    return this.size + 156;
  }
}
class K157 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 157;
  }
}
class K158 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 158;
  }
}
class K159 extends Part {
  weight() {
    return this.size + 159;
  }
}
class K160 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 160;
  }
}
class K161 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 161;
  }
}
class K162 extends Part {
  weight() {
    return this.size + 162;
  }
}
class K163 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 163;
  }
}
class K164 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 164;
  }
}
class K165 extends Part {
  weight() {
    return this.size + 165;
  }
}
class K166 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 166;
  }
}
class K167 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 167;
  }
}
class K168 extends Part {
  weight() {
    return this.size + 168;
  }
}
class K169 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 169;
  }
}
class K170 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 170;
  }
}
class K171 extends Part {
  weight() {
    return this.size + 171;
  }
}
class K172 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 172;
  }
}
class K173 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 173;
  }
}
class K174 extends Part {
  weight() {
    return this.size + 174;
  }
}
class K175 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 175;
  }
}
class K176 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 176;
  }
}
class K177 extends Part {
  weight() {
    return this.size + 177;
  }
}
class K178 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 178;
  }
}
class K179 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 179;
  }
}
class K180 extends Part {
  weight() {
    return this.size + 180;
  }
}
class K181 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 181;
  }
}
class K182 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 182;
  }
}
class K183 extends Part {
  weight() {
    return this.size + 183;
  }
}
class K184 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 184;
  }
}
class K185 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 185;
  }
}
class K186 extends Part {
  weight() {
    return this.size + 186;
  }
}
class K187 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 187;
  }
}
class K188 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 188;
  }
}
class K189 extends Part {
  weight() {
    return this.size + 189;
  }
}
class K190 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 190;
  }
}
class K191 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 191;
  }
}
class K192 extends Part {
  weight() {
    return this.size + 192;
  }
}
class K193 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 193;
  }
}
class K194 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 194;
  }
}
class K195 extends Part {
  weight() {
    return this.size + 195;
  }
}
class K196 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 196;
  }
}
class K197 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 197;
  }
}
class K198 extends Part {
  weight() {
    return this.size + 198;
  }
}
class K199 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 199;
  }
}
class K200 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 200;
  }
}
class K201 extends Part {
  weight() {
    return this.size + 201;
  }
}
class K202 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 202;
  }
}
class K203 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 203;
  }
}
class K204 extends Part {
  weight() {
    return this.size + 204;
  }
}
class K205 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 205;
  }
}
class K206 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 206;
  }
}
class K207 extends Part {
  weight() {
    return this.size + 207;
  }
}
class K208 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 208;
  }
}
class K209 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 209;
  }
}
class K210 extends Part {
  weight() {
    return this.size + 210;
  }
}
class K211 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 211;
  }
}
class K212 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 212;
  }
}
class K213 extends Part {
  weight() {
    return this.size + 213;
  }
}
class K214 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 214;
  }
}
class K215 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 215;
  }
}
class K216 extends Part {
  weight() {
    return this.size + 216;
  }
}
class K217 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 217;
  }
}
class K218 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 218;
  }
}
class K219 extends Part {
  weight() {
    return this.size + 219;
  }
}
class K220 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 220;
  }
}
class K221 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 221;
  }
}
class K222 extends Part {
  weight() {
    return this.size + 222;
  }
}
class K223 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 223;
  }
}
class K224 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 224;
  }
}
class K225 extends Part {
  weight() {
    return this.size + 225;
  }
}
class K226 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 226;
  }
}
class K227 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 227;
  }
}
class K228 extends Part {
  weight() {
    return this.size + 228;
  }
}
class K229 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 229;
  }
}
class K230 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 230;
  }
}
class K231 extends Part {
  weight() {
    return this.size + 231;
  }
}
class K232 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 232;
  }
}
class K233 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 233;
  }
}
class K234 extends Part {
  weight() {
    return this.size + 234;
  }
}
class K235 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 235;
  }
}
class K236 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 236;
  }
}
class K237 extends Part {
  weight() {
    return this.size + 237;
  }
}
class K238 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 238;
  }
}
class K239 {
  constructor(size) {
    this.size = size;
  }
  weight() {
    return this.size * 2 + 239;
  }
}
const kinds = [
  K0, K1, K2, K3, K4, K5, K6, K7, K8, K9, K10, K11,
  K12, K13, K14, K15, K16, K17, K18, K19, K20, K21, K22, K23,
  K24, K25, K26, K27, K28, K29, K30, K31, K32, K33, K34, K35,
  K36, K37, K38, K39, K40, K41, K42, K43, K44, K45, K46, K47,
  K48, K49, K50, K51, K52, K53, K54, K55, K56, K57, K58, K59,
  K60, K61, K62, K63, K64, K65, K66, K67, K68, K69, K70, K71,
  K72, K73, K74, K75, K76, K77, K78, K79, K80, K81, K82, K83,
  K84, K85, K86, K87, K88, K89, K90, K91, K92, K93, K94, K95,
  K96, K97, K98, K99, K100, K101, K102, K103, K104, K105, K106, K107,
  K108, K109, K110, K111, K112, K113, K114, K115, K116, K117, K118, K119,
  K120, K121, K122, K123, K124, K125, K126, K127, K128, K129, K130, K131,
  K132, K133, K134, K135, K136, K137, K138, K139, K140, K141, K142, K143,
  K144, K145, K146, K147, K148, K149, K150, K151, K152, K153, K154, K155,
  K156, K157, K158, K159, K160, K161, K162, K163, K164, K165, K166, K167,
  K168, K169, K170, K171, K172, K173, K174, K175, K176, K177, K178, K179,
  K180, K181, K182, K183, K184, K185, K186, K187, K188, K189, K190, K191,
  K192, K193, K194, K195, K196, K197, K198, K199, K200, K201, K202, K203,
  K204, K205, K206, K207, K208, K209, K210, K211, K212, K213, K214, K215,
  K216, K217, K218, K219, K220, K221, K222, K223, K224, K225, K226, K227,
  K228, K229, K230, K231, K232, K233, K234, K235, K236, K237, K238, K239,
];
const builtins = [RegExp, Date, Map, Uint8Array];
function isA(value, ctor) {
  return value instanceof ctor;
}
function make(ctor, size) {
  return new ctor(size);
}
function copy(value) {
  if (Array.isArray(value)) return value.map((item) => copy(item));
  if (typeof value !== "object" || value === null) return value;
  for (const builtin of builtins) if (isA(value, builtin)) return value;
  const out = {};
  for (const key of Object.keys(value)) out[key] = copy(value[key]);
  return out;
}
const parts = kinds.map((kind, i) => make(kind, i));
const settings = {
  name: "plan",
  limits: { low: 1, high: 9 },
  tags: ["a", "b", "c"],
  when: new Date(0),
  nested: { deep: { value: 5 } },
};
let checksum = 0;
for (let round = 0; round < rounds; round++) {
  const at = round % 240;
  const part = parts[at];
  // The class's own constructor, another class, and the shared base.
  if (isA(part, kinds[at])) checksum += 1;
  if (isA(part, kinds[(at * 7 + 1) % 240])) checksum += 1000;
  if (isA(part, Part)) checksum += 3;
  // A plain record is an instance of none of them.
  if (isA(settings, kinds[(round * 3) % 240])) checksum += 100000;
  if ((round & 7) === 0) {
    const twin = copy(settings);
    checksum += twin.limits.high + twin.tags.length + twin.nested.deep.value;
    if (twin.when !== settings.when) checksum += 100000;
  }
  if ((round & 15) === 0) checksum += make(kinds[(round >> 4) % 240], round & 31).weight();
}
console.log(checksum);
