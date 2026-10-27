// One factory with 600 captured bindings (more than any ordinary function holds),
// shared by methods that read and rebind them, closures created per loop
// iteration, a nested closure, and a function declared before the bindings
// it reads. Every environment observes the same boxes: writes through one
// method are visible through the others and in later calls, and each
// factory call gets its own bindings.
function total(list: number[]): number {
  let t = 0;
  for (const n of list) t += n;
  return t;
}
const one = Number("1");
function make(seed: number) {
  function early(): number {
    return n0 + n539 + s541.length;
  }
  let before = "unset";
  try {
    before = String(early());
  } catch (e) {
    before = (e as Error).name + ": " + (e as Error).message;
  }
  let n0 = seed + 0;
  let n1 = seed + 1;
  let n2 = seed + 2;
  let n3 = seed + 3;
  let n4 = seed + 4;
  let n5 = seed + 5;
  let n6 = seed + 6;
  let n7 = seed + 7;
  let n8 = seed + 8;
  let n9 = seed + 9;
  let n10 = seed + 10;
  let n11 = seed + 11;
  let n12 = seed + 12;
  let n13 = seed + 13;
  let n14 = seed + 14;
  let n15 = seed + 15;
  let n16 = seed + 16;
  let n17 = seed + 17;
  let n18 = seed + 18;
  let n19 = seed + 19;
  let n20 = seed + 20;
  let n21 = seed + 21;
  let n22 = seed + 22;
  let n23 = seed + 23;
  let n24 = seed + 24;
  let n25 = seed + 25;
  let n26 = seed + 26;
  let n27 = seed + 27;
  let n28 = seed + 28;
  let n29 = seed + 29;
  let n30 = seed + 30;
  let n31 = seed + 31;
  let n32 = seed + 32;
  let n33 = seed + 33;
  let n34 = seed + 34;
  let n35 = seed + 35;
  let n36 = seed + 36;
  let n37 = seed + 37;
  let n38 = seed + 38;
  let n39 = seed + 39;
  let n40 = seed + 40;
  let n41 = seed + 41;
  let n42 = seed + 42;
  let n43 = seed + 43;
  let n44 = seed + 44;
  let n45 = seed + 45;
  let n46 = seed + 46;
  let n47 = seed + 47;
  let n48 = seed + 48;
  let n49 = seed + 49;
  let n50 = seed + 50;
  let n51 = seed + 51;
  let n52 = seed + 52;
  let n53 = seed + 53;
  let n54 = seed + 54;
  let n55 = seed + 55;
  let n56 = seed + 56;
  let n57 = seed + 57;
  let n58 = seed + 58;
  let n59 = seed + 59;
  let n60 = seed + 60;
  let n61 = seed + 61;
  let n62 = seed + 62;
  let n63 = seed + 63;
  let n64 = seed + 64;
  let n65 = seed + 65;
  let n66 = seed + 66;
  let n67 = seed + 67;
  let n68 = seed + 68;
  let n69 = seed + 69;
  let n70 = seed + 70;
  let n71 = seed + 71;
  let n72 = seed + 72;
  let n73 = seed + 73;
  let n74 = seed + 74;
  let n75 = seed + 75;
  let n76 = seed + 76;
  let n77 = seed + 77;
  let n78 = seed + 78;
  let n79 = seed + 79;
  let n80 = seed + 80;
  let n81 = seed + 81;
  let n82 = seed + 82;
  let n83 = seed + 83;
  let n84 = seed + 84;
  let n85 = seed + 85;
  let n86 = seed + 86;
  let n87 = seed + 87;
  let n88 = seed + 88;
  let n89 = seed + 89;
  let n90 = seed + 90;
  let n91 = seed + 91;
  let n92 = seed + 92;
  let n93 = seed + 93;
  let n94 = seed + 94;
  let n95 = seed + 95;
  let n96 = seed + 96;
  let n97 = seed + 97;
  let n98 = seed + 98;
  let n99 = seed + 99;
  let n100 = seed + 100;
  let n101 = seed + 101;
  let n102 = seed + 102;
  let n103 = seed + 103;
  let n104 = seed + 104;
  let n105 = seed + 105;
  let n106 = seed + 106;
  let n107 = seed + 107;
  let n108 = seed + 108;
  let n109 = seed + 109;
  let n110 = seed + 110;
  let n111 = seed + 111;
  let n112 = seed + 112;
  let n113 = seed + 113;
  let n114 = seed + 114;
  let n115 = seed + 115;
  let n116 = seed + 116;
  let n117 = seed + 117;
  let n118 = seed + 118;
  let n119 = seed + 119;
  let n120 = seed + 120;
  let n121 = seed + 121;
  let n122 = seed + 122;
  let n123 = seed + 123;
  let n124 = seed + 124;
  let n125 = seed + 125;
  let n126 = seed + 126;
  let n127 = seed + 127;
  let n128 = seed + 128;
  let n129 = seed + 129;
  let n130 = seed + 130;
  let n131 = seed + 131;
  let n132 = seed + 132;
  let n133 = seed + 133;
  let n134 = seed + 134;
  let n135 = seed + 135;
  let n136 = seed + 136;
  let n137 = seed + 137;
  let n138 = seed + 138;
  let n139 = seed + 139;
  let n140 = seed + 140;
  let n141 = seed + 141;
  let n142 = seed + 142;
  let n143 = seed + 143;
  let n144 = seed + 144;
  let n145 = seed + 145;
  let n146 = seed + 146;
  let n147 = seed + 147;
  let n148 = seed + 148;
  let n149 = seed + 149;
  let n150 = seed + 150;
  let n151 = seed + 151;
  let n152 = seed + 152;
  let n153 = seed + 153;
  let n154 = seed + 154;
  let n155 = seed + 155;
  let n156 = seed + 156;
  let n157 = seed + 157;
  let n158 = seed + 158;
  let n159 = seed + 159;
  let n160 = seed + 160;
  let n161 = seed + 161;
  let n162 = seed + 162;
  let n163 = seed + 163;
  let n164 = seed + 164;
  let n165 = seed + 165;
  let n166 = seed + 166;
  let n167 = seed + 167;
  let n168 = seed + 168;
  let n169 = seed + 169;
  let n170 = seed + 170;
  let n171 = seed + 171;
  let n172 = seed + 172;
  let n173 = seed + 173;
  let n174 = seed + 174;
  let n175 = seed + 175;
  let n176 = seed + 176;
  let n177 = seed + 177;
  let n178 = seed + 178;
  let n179 = seed + 179;
  let n180 = seed + 180;
  let n181 = seed + 181;
  let n182 = seed + 182;
  let n183 = seed + 183;
  let n184 = seed + 184;
  let n185 = seed + 185;
  let n186 = seed + 186;
  let n187 = seed + 187;
  let n188 = seed + 188;
  let n189 = seed + 189;
  let n190 = seed + 190;
  let n191 = seed + 191;
  let n192 = seed + 192;
  let n193 = seed + 193;
  let n194 = seed + 194;
  let n195 = seed + 195;
  let n196 = seed + 196;
  let n197 = seed + 197;
  let n198 = seed + 198;
  let n199 = seed + 199;
  let n200 = seed + 200;
  let n201 = seed + 201;
  let n202 = seed + 202;
  let n203 = seed + 203;
  let n204 = seed + 204;
  let n205 = seed + 205;
  let n206 = seed + 206;
  let n207 = seed + 207;
  let n208 = seed + 208;
  let n209 = seed + 209;
  let n210 = seed + 210;
  let n211 = seed + 211;
  let n212 = seed + 212;
  let n213 = seed + 213;
  let n214 = seed + 214;
  let n215 = seed + 215;
  let n216 = seed + 216;
  let n217 = seed + 217;
  let n218 = seed + 218;
  let n219 = seed + 219;
  let n220 = seed + 220;
  let n221 = seed + 221;
  let n222 = seed + 222;
  let n223 = seed + 223;
  let n224 = seed + 224;
  let n225 = seed + 225;
  let n226 = seed + 226;
  let n227 = seed + 227;
  let n228 = seed + 228;
  let n229 = seed + 229;
  let n230 = seed + 230;
  let n231 = seed + 231;
  let n232 = seed + 232;
  let n233 = seed + 233;
  let n234 = seed + 234;
  let n235 = seed + 235;
  let n236 = seed + 236;
  let n237 = seed + 237;
  let n238 = seed + 238;
  let n239 = seed + 239;
  let n240 = seed + 240;
  let n241 = seed + 241;
  let n242 = seed + 242;
  let n243 = seed + 243;
  let n244 = seed + 244;
  let n245 = seed + 245;
  let n246 = seed + 246;
  let n247 = seed + 247;
  let n248 = seed + 248;
  let n249 = seed + 249;
  let n250 = seed + 250;
  let n251 = seed + 251;
  let n252 = seed + 252;
  let n253 = seed + 253;
  let n254 = seed + 254;
  let n255 = seed + 255;
  let n256 = seed + 256;
  let n257 = seed + 257;
  let n258 = seed + 258;
  let n259 = seed + 259;
  let n260 = seed + 260;
  let n261 = seed + 261;
  let n262 = seed + 262;
  let n263 = seed + 263;
  let n264 = seed + 264;
  let n265 = seed + 265;
  let n266 = seed + 266;
  let n267 = seed + 267;
  let n268 = seed + 268;
  let n269 = seed + 269;
  let n270 = seed + 270;
  let n271 = seed + 271;
  let n272 = seed + 272;
  let n273 = seed + 273;
  let n274 = seed + 274;
  let n275 = seed + 275;
  let n276 = seed + 276;
  let n277 = seed + 277;
  let n278 = seed + 278;
  let n279 = seed + 279;
  let n280 = seed + 280;
  let n281 = seed + 281;
  let n282 = seed + 282;
  let n283 = seed + 283;
  let n284 = seed + 284;
  let n285 = seed + 285;
  let n286 = seed + 286;
  let n287 = seed + 287;
  let n288 = seed + 288;
  let n289 = seed + 289;
  let n290 = seed + 290;
  let n291 = seed + 291;
  let n292 = seed + 292;
  let n293 = seed + 293;
  let n294 = seed + 294;
  let n295 = seed + 295;
  let n296 = seed + 296;
  let n297 = seed + 297;
  let n298 = seed + 298;
  let n299 = seed + 299;
  let n300 = seed + 300;
  let n301 = seed + 301;
  let n302 = seed + 302;
  let n303 = seed + 303;
  let n304 = seed + 304;
  let n305 = seed + 305;
  let n306 = seed + 306;
  let n307 = seed + 307;
  let n308 = seed + 308;
  let n309 = seed + 309;
  let n310 = seed + 310;
  let n311 = seed + 311;
  let n312 = seed + 312;
  let n313 = seed + 313;
  let n314 = seed + 314;
  let n315 = seed + 315;
  let n316 = seed + 316;
  let n317 = seed + 317;
  let n318 = seed + 318;
  let n319 = seed + 319;
  let n320 = seed + 320;
  let n321 = seed + 321;
  let n322 = seed + 322;
  let n323 = seed + 323;
  let n324 = seed + 324;
  let n325 = seed + 325;
  let n326 = seed + 326;
  let n327 = seed + 327;
  let n328 = seed + 328;
  let n329 = seed + 329;
  let n330 = seed + 330;
  let n331 = seed + 331;
  let n332 = seed + 332;
  let n333 = seed + 333;
  let n334 = seed + 334;
  let n335 = seed + 335;
  let n336 = seed + 336;
  let n337 = seed + 337;
  let n338 = seed + 338;
  let n339 = seed + 339;
  let n340 = seed + 340;
  let n341 = seed + 341;
  let n342 = seed + 342;
  let n343 = seed + 343;
  let n344 = seed + 344;
  let n345 = seed + 345;
  let n346 = seed + 346;
  let n347 = seed + 347;
  let n348 = seed + 348;
  let n349 = seed + 349;
  let n350 = seed + 350;
  let n351 = seed + 351;
  let n352 = seed + 352;
  let n353 = seed + 353;
  let n354 = seed + 354;
  let n355 = seed + 355;
  let n356 = seed + 356;
  let n357 = seed + 357;
  let n358 = seed + 358;
  let n359 = seed + 359;
  let n360 = seed + 360;
  let n361 = seed + 361;
  let n362 = seed + 362;
  let n363 = seed + 363;
  let n364 = seed + 364;
  let n365 = seed + 365;
  let n366 = seed + 366;
  let n367 = seed + 367;
  let n368 = seed + 368;
  let n369 = seed + 369;
  let n370 = seed + 370;
  let n371 = seed + 371;
  let n372 = seed + 372;
  let n373 = seed + 373;
  let n374 = seed + 374;
  let n375 = seed + 375;
  let n376 = seed + 376;
  let n377 = seed + 377;
  let n378 = seed + 378;
  let n379 = seed + 379;
  let n380 = seed + 380;
  let n381 = seed + 381;
  let n382 = seed + 382;
  let n383 = seed + 383;
  let n384 = seed + 384;
  let n385 = seed + 385;
  let n386 = seed + 386;
  let n387 = seed + 387;
  let n388 = seed + 388;
  let n389 = seed + 389;
  let n390 = seed + 390;
  let n391 = seed + 391;
  let n392 = seed + 392;
  let n393 = seed + 393;
  let n394 = seed + 394;
  let n395 = seed + 395;
  let n396 = seed + 396;
  let n397 = seed + 397;
  let n398 = seed + 398;
  let n399 = seed + 399;
  let n400 = seed + 400;
  let n401 = seed + 401;
  let n402 = seed + 402;
  let n403 = seed + 403;
  let n404 = seed + 404;
  let n405 = seed + 405;
  let n406 = seed + 406;
  let n407 = seed + 407;
  let n408 = seed + 408;
  let n409 = seed + 409;
  let n410 = seed + 410;
  let n411 = seed + 411;
  let n412 = seed + 412;
  let n413 = seed + 413;
  let n414 = seed + 414;
  let n415 = seed + 415;
  let n416 = seed + 416;
  let n417 = seed + 417;
  let n418 = seed + 418;
  let n419 = seed + 419;
  let n420 = seed + 420;
  let n421 = seed + 421;
  let n422 = seed + 422;
  let n423 = seed + 423;
  let n424 = seed + 424;
  let n425 = seed + 425;
  let n426 = seed + 426;
  let n427 = seed + 427;
  let n428 = seed + 428;
  let n429 = seed + 429;
  let n430 = seed + 430;
  let n431 = seed + 431;
  let n432 = seed + 432;
  let n433 = seed + 433;
  let n434 = seed + 434;
  let n435 = seed + 435;
  let n436 = seed + 436;
  let n437 = seed + 437;
  let n438 = seed + 438;
  let n439 = seed + 439;
  let n440 = seed + 440;
  let n441 = seed + 441;
  let n442 = seed + 442;
  let n443 = seed + 443;
  let n444 = seed + 444;
  let n445 = seed + 445;
  let n446 = seed + 446;
  let n447 = seed + 447;
  let n448 = seed + 448;
  let n449 = seed + 449;
  let n450 = seed + 450;
  let n451 = seed + 451;
  let n452 = seed + 452;
  let n453 = seed + 453;
  let n454 = seed + 454;
  let n455 = seed + 455;
  let n456 = seed + 456;
  let n457 = seed + 457;
  let n458 = seed + 458;
  let n459 = seed + 459;
  let n460 = seed + 460;
  let n461 = seed + 461;
  let n462 = seed + 462;
  let n463 = seed + 463;
  let n464 = seed + 464;
  let n465 = seed + 465;
  let n466 = seed + 466;
  let n467 = seed + 467;
  let n468 = seed + 468;
  let n469 = seed + 469;
  let n470 = seed + 470;
  let n471 = seed + 471;
  let n472 = seed + 472;
  let n473 = seed + 473;
  let n474 = seed + 474;
  let n475 = seed + 475;
  let n476 = seed + 476;
  let n477 = seed + 477;
  let n478 = seed + 478;
  let n479 = seed + 479;
  let n480 = seed + 480;
  let n481 = seed + 481;
  let n482 = seed + 482;
  let n483 = seed + 483;
  let n484 = seed + 484;
  let n485 = seed + 485;
  let n486 = seed + 486;
  let n487 = seed + 487;
  let n488 = seed + 488;
  let n489 = seed + 489;
  let n490 = seed + 490;
  let n491 = seed + 491;
  let n492 = seed + 492;
  let n493 = seed + 493;
  let n494 = seed + 494;
  let n495 = seed + 495;
  let n496 = seed + 496;
  let n497 = seed + 497;
  let n498 = seed + 498;
  let n499 = seed + 499;
  let n500 = seed + 500;
  let n501 = seed + 501;
  let n502 = seed + 502;
  let n503 = seed + 503;
  let n504 = seed + 504;
  let n505 = seed + 505;
  let n506 = seed + 506;
  let n507 = seed + 507;
  let n508 = seed + 508;
  let n509 = seed + 509;
  let n510 = seed + 510;
  let n511 = seed + 511;
  let n512 = seed + 512;
  let n513 = seed + 513;
  let n514 = seed + 514;
  let n515 = seed + 515;
  let n516 = seed + 516;
  let n517 = seed + 517;
  let n518 = seed + 518;
  let n519 = seed + 519;
  let n520 = seed + 520;
  let n521 = seed + 521;
  let n522 = seed + 522;
  let n523 = seed + 523;
  let n524 = seed + 524;
  let n525 = seed + 525;
  let n526 = seed + 526;
  let n527 = seed + 527;
  let n528 = seed + 528;
  let n529 = seed + 529;
  let n530 = seed + 530;
  let n531 = seed + 531;
  let n532 = seed + 532;
  let n533 = seed + 533;
  let n534 = seed + 534;
  let n535 = seed + 535;
  let n536 = seed + 536;
  let n537 = seed + 537;
  let n538 = seed + 538;
  let n539 = seed + 539;
  let o540 = { x: 540 };
  let s541 = "s" + (541 + one);
  let o542 = { x: 542 };
  let s543 = "s" + (543 + one);
  let o544 = { x: 544 };
  let s545 = "s" + (545 + one);
  let o546 = { x: 546 };
  let s547 = "s" + (547 + one);
  let o548 = { x: 548 };
  let s549 = "s" + (549 + one);
  let o550 = { x: 550 };
  let s551 = "s" + (551 + one);
  let o552 = { x: 552 };
  let s553 = "s" + (553 + one);
  let o554 = { x: 554 };
  let s555 = "s" + (555 + one);
  let o556 = { x: 556 };
  let s557 = "s" + (557 + one);
  let o558 = { x: 558 };
  let s559 = "s" + (559 + one);
  let o560 = { x: 560 };
  let s561 = "s" + (561 + one);
  let o562 = { x: 562 };
  let s563 = "s" + (563 + one);
  let o564 = { x: 564 };
  let s565 = "s" + (565 + one);
  let o566 = { x: 566 };
  let s567 = "s" + (567 + one);
  let o568 = { x: 568 };
  let s569 = "s" + (569 + one);
  let o570 = { x: 570 };
  let s571 = "s" + (571 + one);
  let o572 = { x: 572 };
  let s573 = "s" + (573 + one);
  let o574 = { x: 574 };
  let s575 = "s" + (575 + one);
  let o576 = { x: 576 };
  let s577 = "s" + (577 + one);
  let o578 = { x: 578 };
  let s579 = "s" + (579 + one);
  let o580 = { x: 580 };
  let s581 = "s" + (581 + one);
  let o582 = { x: 582 };
  let s583 = "s" + (583 + one);
  let o584 = { x: 584 };
  let s585 = "s" + (585 + one);
  let o586 = { x: 586 };
  let s587 = "s" + (587 + one);
  let o588 = { x: 588 };
  let s589 = "s" + (589 + one);
  let o590 = { x: 590 };
  let s591 = "s" + (591 + one);
  let o592 = { x: 592 };
  let s593 = "s" + (593 + one);
  let o594 = { x: 594 };
  let s595 = "s" + (595 + one);
  let o596 = { x: 596 };
  let s597 = "s" + (597 + one);
  let o598 = { x: 598 };
  let s599 = "s" + (599 + one);
  const readers: (() => string)[] = [];
  for (let i = 0; i < 3; i++) {
    const label = "r" + i;
    readers.push(() => label + ":" + (n539 + i) + ":" + o540.x + ":" + s541);
  }
  return {
    before,
    early,
    sum(): number {
      return total([
        n0,
        n1,
        n2,
        n3,
        n4,
        n5,
        n6,
        n7,
        n8,
        n9,
        n10,
        n11,
        n12,
        n13,
        n14,
        n15,
        n16,
        n17,
        n18,
        n19,
        n20,
        n21,
        n22,
        n23,
        n24,
        n25,
        n26,
        n27,
        n28,
        n29,
        n30,
        n31,
        n32,
        n33,
        n34,
        n35,
        n36,
        n37,
        n38,
        n39,
        n40,
        n41,
        n42,
        n43,
        n44,
        n45,
        n46,
        n47,
        n48,
        n49,
        n50,
        n51,
        n52,
        n53,
        n54,
        n55,
        n56,
        n57,
        n58,
        n59,
        n60,
        n61,
        n62,
        n63,
        n64,
        n65,
        n66,
        n67,
        n68,
        n69,
        n70,
        n71,
        n72,
        n73,
        n74,
        n75,
        n76,
        n77,
        n78,
        n79,
        n80,
        n81,
        n82,
        n83,
        n84,
        n85,
        n86,
        n87,
        n88,
        n89,
        n90,
        n91,
        n92,
        n93,
        n94,
        n95,
        n96,
        n97,
        n98,
        n99,
        n100,
        n101,
        n102,
        n103,
        n104,
        n105,
        n106,
        n107,
        n108,
        n109,
        n110,
        n111,
        n112,
        n113,
        n114,
        n115,
        n116,
        n117,
        n118,
        n119,
        n120,
        n121,
        n122,
        n123,
        n124,
        n125,
        n126,
        n127,
        n128,
        n129,
        n130,
        n131,
        n132,
        n133,
        n134,
        n135,
        n136,
        n137,
        n138,
        n139,
        n140,
        n141,
        n142,
        n143,
        n144,
        n145,
        n146,
        n147,
        n148,
        n149,
        n150,
        n151,
        n152,
        n153,
        n154,
        n155,
        n156,
        n157,
        n158,
        n159,
        n160,
        n161,
        n162,
        n163,
        n164,
        n165,
        n166,
        n167,
        n168,
        n169,
        n170,
        n171,
        n172,
        n173,
        n174,
        n175,
        n176,
        n177,
        n178,
        n179,
        n180,
        n181,
        n182,
        n183,
        n184,
        n185,
        n186,
        n187,
        n188,
        n189,
        n190,
        n191,
        n192,
        n193,
        n194,
        n195,
        n196,
        n197,
        n198,
        n199,
        n200,
        n201,
        n202,
        n203,
        n204,
        n205,
        n206,
        n207,
        n208,
        n209,
        n210,
        n211,
        n212,
        n213,
        n214,
        n215,
        n216,
        n217,
        n218,
        n219,
        n220,
        n221,
        n222,
        n223,
        n224,
        n225,
        n226,
        n227,
        n228,
        n229,
        n230,
        n231,
        n232,
        n233,
        n234,
        n235,
        n236,
        n237,
        n238,
        n239,
        n240,
        n241,
        n242,
        n243,
        n244,
        n245,
        n246,
        n247,
        n248,
        n249,
        n250,
        n251,
        n252,
        n253,
        n254,
        n255,
        n256,
        n257,
        n258,
        n259,
        n260,
        n261,
        n262,
        n263,
        n264,
        n265,
        n266,
        n267,
        n268,
        n269,
        n270,
        n271,
        n272,
        n273,
        n274,
        n275,
        n276,
        n277,
        n278,
        n279,
        n280,
        n281,
        n282,
        n283,
        n284,
        n285,
        n286,
        n287,
        n288,
        n289,
        n290,
        n291,
        n292,
        n293,
        n294,
        n295,
        n296,
        n297,
        n298,
        n299,
        n300,
        n301,
        n302,
        n303,
        n304,
        n305,
        n306,
        n307,
        n308,
        n309,
        n310,
        n311,
        n312,
        n313,
        n314,
        n315,
        n316,
        n317,
        n318,
        n319,
        n320,
        n321,
        n322,
        n323,
        n324,
        n325,
        n326,
        n327,
        n328,
        n329,
        n330,
        n331,
        n332,
        n333,
        n334,
        n335,
        n336,
        n337,
        n338,
        n339,
        n340,
        n341,
        n342,
        n343,
        n344,
        n345,
        n346,
        n347,
        n348,
        n349,
        n350,
        n351,
        n352,
        n353,
        n354,
        n355,
        n356,
        n357,
        n358,
        n359,
        n360,
        n361,
        n362,
        n363,
        n364,
        n365,
        n366,
        n367,
        n368,
        n369,
        n370,
        n371,
        n372,
        n373,
        n374,
        n375,
        n376,
        n377,
        n378,
        n379,
        n380,
        n381,
        n382,
        n383,
        n384,
        n385,
        n386,
        n387,
        n388,
        n389,
        n390,
        n391,
        n392,
        n393,
        n394,
        n395,
        n396,
        n397,
        n398,
        n399,
        n400,
        n401,
        n402,
        n403,
        n404,
        n405,
        n406,
        n407,
        n408,
        n409,
        n410,
        n411,
        n412,
        n413,
        n414,
        n415,
        n416,
        n417,
        n418,
        n419,
        n420,
        n421,
        n422,
        n423,
        n424,
        n425,
        n426,
        n427,
        n428,
        n429,
        n430,
        n431,
        n432,
        n433,
        n434,
        n435,
        n436,
        n437,
        n438,
        n439,
        n440,
        n441,
        n442,
        n443,
        n444,
        n445,
        n446,
        n447,
        n448,
        n449,
        n450,
        n451,
        n452,
        n453,
        n454,
        n455,
        n456,
        n457,
        n458,
        n459,
        n460,
        n461,
        n462,
        n463,
        n464,
        n465,
        n466,
        n467,
        n468,
        n469,
        n470,
        n471,
        n472,
        n473,
        n474,
        n475,
        n476,
        n477,
        n478,
        n479,
        n480,
        n481,
        n482,
        n483,
        n484,
        n485,
        n486,
        n487,
        n488,
        n489,
        n490,
        n491,
        n492,
        n493,
        n494,
        n495,
        n496,
        n497,
        n498,
        n499,
        n500,
        n501,
        n502,
        n503,
        n504,
        n505,
        n506,
        n507,
        n508,
        n509,
        n510,
        n511,
        n512,
        n513,
        n514,
        n515,
        n516,
        n517,
        n518,
        n519,
        n520,
        n521,
        n522,
        n523,
        n524,
        n525,
        n526,
        n527,
        n528,
        n529,
        n530,
        n531,
        n532,
        n533,
        n534,
        n535,
        n536,
        n537,
        n538,
        n539,
        o540.x,
        s541.length,
        o542.x,
        s543.length,
        o544.x,
        s545.length,
        o546.x,
        s547.length,
        o548.x,
        s549.length,
        o550.x,
        s551.length,
        o552.x,
        s553.length,
        o554.x,
        s555.length,
        o556.x,
        s557.length,
        o558.x,
        s559.length,
        o560.x,
        s561.length,
        o562.x,
        s563.length,
        o564.x,
        s565.length,
        o566.x,
        s567.length,
        o568.x,
        s569.length,
        o570.x,
        s571.length,
        o572.x,
        s573.length,
        o574.x,
        s575.length,
        o576.x,
        s577.length,
        o578.x,
        s579.length,
        o580.x,
        s581.length,
        o582.x,
        s583.length,
        o584.x,
        s585.length,
        o586.x,
        s587.length,
        o588.x,
        s589.length,
        o590.x,
        s591.length,
        o592.x,
        s593.length,
        o594.x,
        s595.length,
        o596.x,
        s597.length,
        o598.x,
        s599.length,
      ]);
    },
    bump(): void {
      n0 += 1;
      n1 += 1;
      n2 += 1;
      n3 += 1;
      n4 += 1;
      n5 += 1;
      n6 += 1;
      n7 += 1;
      n8 += 1;
      n9 += 1;
      n10 += 1;
      n11 += 1;
      n12 += 1;
      n13 += 1;
      n14 += 1;
      n15 += 1;
      n16 += 1;
      n17 += 1;
      n18 += 1;
      n19 += 1;
      n20 += 1;
      n21 += 1;
      n22 += 1;
      n23 += 1;
      n24 += 1;
      n25 += 1;
      n26 += 1;
      n27 += 1;
      n28 += 1;
      n29 += 1;
      n30 += 1;
      n31 += 1;
      n32 += 1;
      n33 += 1;
      n34 += 1;
      n35 += 1;
      n36 += 1;
      n37 += 1;
      n38 += 1;
      n39 += 1;
      n40 += 1;
      n41 += 1;
      n42 += 1;
      n43 += 1;
      n44 += 1;
      n45 += 1;
      n46 += 1;
      n47 += 1;
      n48 += 1;
      n49 += 1;
      n50 += 1;
      n51 += 1;
      n52 += 1;
      n53 += 1;
      n54 += 1;
      n55 += 1;
      n56 += 1;
      n57 += 1;
      n58 += 1;
      n59 += 1;
      n60 += 1;
      n61 += 1;
      n62 += 1;
      n63 += 1;
      n64 += 1;
      n65 += 1;
      n66 += 1;
      n67 += 1;
      n68 += 1;
      n69 += 1;
      n70 += 1;
      n71 += 1;
      n72 += 1;
      n73 += 1;
      n74 += 1;
      n75 += 1;
      n76 += 1;
      n77 += 1;
      n78 += 1;
      n79 += 1;
      n80 += 1;
      n81 += 1;
      n82 += 1;
      n83 += 1;
      n84 += 1;
      n85 += 1;
      n86 += 1;
      n87 += 1;
      n88 += 1;
      n89 += 1;
      n90 += 1;
      n91 += 1;
      n92 += 1;
      n93 += 1;
      n94 += 1;
      n95 += 1;
      n96 += 1;
      n97 += 1;
      n98 += 1;
      n99 += 1;
      n100 += 1;
      n101 += 1;
      n102 += 1;
      n103 += 1;
      n104 += 1;
      n105 += 1;
      n106 += 1;
      n107 += 1;
      n108 += 1;
      n109 += 1;
      n110 += 1;
      n111 += 1;
      n112 += 1;
      n113 += 1;
      n114 += 1;
      n115 += 1;
      n116 += 1;
      n117 += 1;
      n118 += 1;
      n119 += 1;
      n120 += 1;
      n121 += 1;
      n122 += 1;
      n123 += 1;
      n124 += 1;
      n125 += 1;
      n126 += 1;
      n127 += 1;
      n128 += 1;
      n129 += 1;
      n130 += 1;
      n131 += 1;
      n132 += 1;
      n133 += 1;
      n134 += 1;
      n135 += 1;
      n136 += 1;
      n137 += 1;
      n138 += 1;
      n139 += 1;
      n140 += 1;
      n141 += 1;
      n142 += 1;
      n143 += 1;
      n144 += 1;
      n145 += 1;
      n146 += 1;
      n147 += 1;
      n148 += 1;
      n149 += 1;
      n150 += 1;
      n151 += 1;
      n152 += 1;
      n153 += 1;
      n154 += 1;
      n155 += 1;
      n156 += 1;
      n157 += 1;
      n158 += 1;
      n159 += 1;
      n160 += 1;
      n161 += 1;
      n162 += 1;
      n163 += 1;
      n164 += 1;
      n165 += 1;
      n166 += 1;
      n167 += 1;
      n168 += 1;
      n169 += 1;
      n170 += 1;
      n171 += 1;
      n172 += 1;
      n173 += 1;
      n174 += 1;
      n175 += 1;
      n176 += 1;
      n177 += 1;
      n178 += 1;
      n179 += 1;
      n180 += 1;
      n181 += 1;
      n182 += 1;
      n183 += 1;
      n184 += 1;
      n185 += 1;
      n186 += 1;
      n187 += 1;
      n188 += 1;
      n189 += 1;
      n190 += 1;
      n191 += 1;
      n192 += 1;
      n193 += 1;
      n194 += 1;
      n195 += 1;
      n196 += 1;
      n197 += 1;
      n198 += 1;
      n199 += 1;
      n200 += 1;
      n201 += 1;
      n202 += 1;
      n203 += 1;
      n204 += 1;
      n205 += 1;
      n206 += 1;
      n207 += 1;
      n208 += 1;
      n209 += 1;
      n210 += 1;
      n211 += 1;
      n212 += 1;
      n213 += 1;
      n214 += 1;
      n215 += 1;
      n216 += 1;
      n217 += 1;
      n218 += 1;
      n219 += 1;
      n220 += 1;
      n221 += 1;
      n222 += 1;
      n223 += 1;
      n224 += 1;
      n225 += 1;
      n226 += 1;
      n227 += 1;
      n228 += 1;
      n229 += 1;
      n230 += 1;
      n231 += 1;
      n232 += 1;
      n233 += 1;
      n234 += 1;
      n235 += 1;
      n236 += 1;
      n237 += 1;
      n238 += 1;
      n239 += 1;
      n240 += 1;
      n241 += 1;
      n242 += 1;
      n243 += 1;
      n244 += 1;
      n245 += 1;
      n246 += 1;
      n247 += 1;
      n248 += 1;
      n249 += 1;
      n250 += 1;
      n251 += 1;
      n252 += 1;
      n253 += 1;
      n254 += 1;
      n255 += 1;
      n256 += 1;
      n257 += 1;
      n258 += 1;
      n259 += 1;
      n260 += 1;
      n261 += 1;
      n262 += 1;
      n263 += 1;
      n264 += 1;
      n265 += 1;
      n266 += 1;
      n267 += 1;
      n268 += 1;
      n269 += 1;
      n270 += 1;
      n271 += 1;
      n272 += 1;
      n273 += 1;
      n274 += 1;
      n275 += 1;
      n276 += 1;
      n277 += 1;
      n278 += 1;
      n279 += 1;
      n280 += 1;
      n281 += 1;
      n282 += 1;
      n283 += 1;
      n284 += 1;
      n285 += 1;
      n286 += 1;
      n287 += 1;
      n288 += 1;
      n289 += 1;
      n290 += 1;
      n291 += 1;
      n292 += 1;
      n293 += 1;
      n294 += 1;
      n295 += 1;
      n296 += 1;
      n297 += 1;
      n298 += 1;
      n299 += 1;
      n300 += 1;
      n301 += 1;
      n302 += 1;
      n303 += 1;
      n304 += 1;
      n305 += 1;
      n306 += 1;
      n307 += 1;
      n308 += 1;
      n309 += 1;
      n310 += 1;
      n311 += 1;
      n312 += 1;
      n313 += 1;
      n314 += 1;
      n315 += 1;
      n316 += 1;
      n317 += 1;
      n318 += 1;
      n319 += 1;
      n320 += 1;
      n321 += 1;
      n322 += 1;
      n323 += 1;
      n324 += 1;
      n325 += 1;
      n326 += 1;
      n327 += 1;
      n328 += 1;
      n329 += 1;
      n330 += 1;
      n331 += 1;
      n332 += 1;
      n333 += 1;
      n334 += 1;
      n335 += 1;
      n336 += 1;
      n337 += 1;
      n338 += 1;
      n339 += 1;
      n340 += 1;
      n341 += 1;
      n342 += 1;
      n343 += 1;
      n344 += 1;
      n345 += 1;
      n346 += 1;
      n347 += 1;
      n348 += 1;
      n349 += 1;
      n350 += 1;
      n351 += 1;
      n352 += 1;
      n353 += 1;
      n354 += 1;
      n355 += 1;
      n356 += 1;
      n357 += 1;
      n358 += 1;
      n359 += 1;
      n360 += 1;
      n361 += 1;
      n362 += 1;
      n363 += 1;
      n364 += 1;
      n365 += 1;
      n366 += 1;
      n367 += 1;
      n368 += 1;
      n369 += 1;
      n370 += 1;
      n371 += 1;
      n372 += 1;
      n373 += 1;
      n374 += 1;
      n375 += 1;
      n376 += 1;
      n377 += 1;
      n378 += 1;
      n379 += 1;
      n380 += 1;
      n381 += 1;
      n382 += 1;
      n383 += 1;
      n384 += 1;
      n385 += 1;
      n386 += 1;
      n387 += 1;
      n388 += 1;
      n389 += 1;
      n390 += 1;
      n391 += 1;
      n392 += 1;
      n393 += 1;
      n394 += 1;
      n395 += 1;
      n396 += 1;
      n397 += 1;
      n398 += 1;
      n399 += 1;
      n400 += 1;
      n401 += 1;
      n402 += 1;
      n403 += 1;
      n404 += 1;
      n405 += 1;
      n406 += 1;
      n407 += 1;
      n408 += 1;
      n409 += 1;
      n410 += 1;
      n411 += 1;
      n412 += 1;
      n413 += 1;
      n414 += 1;
      n415 += 1;
      n416 += 1;
      n417 += 1;
      n418 += 1;
      n419 += 1;
      n420 += 1;
      n421 += 1;
      n422 += 1;
      n423 += 1;
      n424 += 1;
      n425 += 1;
      n426 += 1;
      n427 += 1;
      n428 += 1;
      n429 += 1;
      n430 += 1;
      n431 += 1;
      n432 += 1;
      n433 += 1;
      n434 += 1;
      n435 += 1;
      n436 += 1;
      n437 += 1;
      n438 += 1;
      n439 += 1;
      n440 += 1;
      n441 += 1;
      n442 += 1;
      n443 += 1;
      n444 += 1;
      n445 += 1;
      n446 += 1;
      n447 += 1;
      n448 += 1;
      n449 += 1;
      n450 += 1;
      n451 += 1;
      n452 += 1;
      n453 += 1;
      n454 += 1;
      n455 += 1;
      n456 += 1;
      n457 += 1;
      n458 += 1;
      n459 += 1;
      n460 += 1;
      n461 += 1;
      n462 += 1;
      n463 += 1;
      n464 += 1;
      n465 += 1;
      n466 += 1;
      n467 += 1;
      n468 += 1;
      n469 += 1;
      n470 += 1;
      n471 += 1;
      n472 += 1;
      n473 += 1;
      n474 += 1;
      n475 += 1;
      n476 += 1;
      n477 += 1;
      n478 += 1;
      n479 += 1;
      n480 += 1;
      n481 += 1;
      n482 += 1;
      n483 += 1;
      n484 += 1;
      n485 += 1;
      n486 += 1;
      n487 += 1;
      n488 += 1;
      n489 += 1;
      n490 += 1;
      n491 += 1;
      n492 += 1;
      n493 += 1;
      n494 += 1;
      n495 += 1;
      n496 += 1;
      n497 += 1;
      n498 += 1;
      n499 += 1;
      n500 += 1;
      n501 += 1;
      n502 += 1;
      n503 += 1;
      n504 += 1;
      n505 += 1;
      n506 += 1;
      n507 += 1;
      n508 += 1;
      n509 += 1;
      n510 += 1;
      n511 += 1;
      n512 += 1;
      n513 += 1;
      n514 += 1;
      n515 += 1;
      n516 += 1;
      n517 += 1;
      n518 += 1;
      n519 += 1;
      n520 += 1;
      n521 += 1;
      n522 += 1;
      n523 += 1;
      n524 += 1;
      n525 += 1;
      n526 += 1;
      n527 += 1;
      n528 += 1;
      n529 += 1;
      n530 += 1;
      n531 += 1;
      n532 += 1;
      n533 += 1;
      n534 += 1;
      n535 += 1;
      n536 += 1;
      n537 += 1;
      n538 += 1;
      n539 += 1;
      o540 = { x: o540.x + 1 };
      s541 += "!";
      o542 = { x: o542.x + 1 };
      s543 += "!";
      o544 = { x: o544.x + 1 };
      s545 += "!";
      o546 = { x: o546.x + 1 };
      s547 += "!";
      o548 = { x: o548.x + 1 };
      s549 += "!";
      o550 = { x: o550.x + 1 };
      s551 += "!";
      o552 = { x: o552.x + 1 };
      s553 += "!";
      o554 = { x: o554.x + 1 };
      s555 += "!";
      o556 = { x: o556.x + 1 };
      s557 += "!";
      o558 = { x: o558.x + 1 };
      s559 += "!";
      o560 = { x: o560.x + 1 };
      s561 += "!";
      o562 = { x: o562.x + 1 };
      s563 += "!";
      o564 = { x: o564.x + 1 };
      s565 += "!";
      o566 = { x: o566.x + 1 };
      s567 += "!";
      o568 = { x: o568.x + 1 };
      s569 += "!";
      o570 = { x: o570.x + 1 };
      s571 += "!";
      o572 = { x: o572.x + 1 };
      s573 += "!";
      o574 = { x: o574.x + 1 };
      s575 += "!";
      o576 = { x: o576.x + 1 };
      s577 += "!";
      o578 = { x: o578.x + 1 };
      s579 += "!";
      o580 = { x: o580.x + 1 };
      s581 += "!";
      o582 = { x: o582.x + 1 };
      s583 += "!";
      o584 = { x: o584.x + 1 };
      s585 += "!";
      o586 = { x: o586.x + 1 };
      s587 += "!";
      o588 = { x: o588.x + 1 };
      s589 += "!";
      o590 = { x: o590.x + 1 };
      s591 += "!";
      o592 = { x: o592.x + 1 };
      s593 += "!";
      o594 = { x: o594.x + 1 };
      s595 += "!";
      o596 = { x: o596.x + 1 };
      s597 += "!";
      o598 = { x: o598.x + 1 };
      s599 += "!";
    },
    readers,
    nested(): () => string {
      let calls = 0;
      return () => {
        calls++;
        n0 += 10;
        return calls + "/" + n0 + "/" + s599;
      };
    },
  };
}
const a = make(0);
const b = make(100);
console.log(a.before);
console.log(a.sum(), b.sum(), a.early());
a.bump();
a.bump();
console.log(a.sum(), b.sum(), a.early());
console.log(a.readers.map((r) => r()).join(" "));
const next = a.nested();
console.log(next(), next(), a.sum());
b.bump();
console.log(b.readers.map((r) => r()).join(" "), b.early());
