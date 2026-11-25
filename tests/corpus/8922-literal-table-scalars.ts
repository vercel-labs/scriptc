// Large literal tables of numbers, strings, booleans, nested arrays, and
// collections seeded from them. Each is used in a way that keeps it an
// ordinary array: iterated, mutated through an alias, resized.
const NUMS: number[] = [
0, 1.5, 5831, -3743, 4.5, -0, 1e21, 5e-324, Infinity, -Infinity, 10.5, 7053, -4965, 13.5, 789, -8708, 16.5, 4532, -2444, 19.5, 8275, -6187, 22.5, 2011, -9930, 25.5, 5754, -3666, 28.5, 9497, -7409, 31.5, 3233, -1145, 34.5, 6976, -4888, 37.5, 712, -8631, 40.5, 4455, -2367, 43.5, 8198, -6110, 46.5, 1934, -9853, 49.5, 5677, -3589, 52.5, 9420, -7332, 55.5, 3156, -1068, 58.5, 6899, -4811, 61.5, 635, -8554, 64.5, 4378, -2290, 67.5, 8121, -6033, 70.5, 1857, -9776, 73.5, 5600, -3512, 76.5, 9343, -7255, 79.5, 3079, -991, 82.5, 6822, -4734, 85.5, 558, -8477, 88.5, 4301, -2213, 91.5, 8044, -5956, 94.5, 1780, -9699, 97.5, 5523, -3435, 100.5, 9266, -7178, 103.5, 3002, -914, 106.5, 6745, -4657, 109.5, 481, -8400, 112.5, 4224, -2136, 115.5, 7967, -5879, 118.5, 1703, -9622, 121.5, 5446, -3358, 124.5, 9189, -7101, 127.5, 2925, -837, 130.5, 6668, -4580, 133.5, 404, -8323, 136.5, 4147, -2059, 139.5, 7890, -5802, 142.5, 1626, -9545, 145.5, 5369, -3281, 148.5, 9112, -7024, 151.5, 2848, -760, 154.5, 6591, -4503, 157.5, 327, -8246, 160.5, 4070, -1982, 163.5, 7813, -5725, 166.5, 1549, -9468, 169.5, 5292, -3204, 172.5, 9035, -6947, 175.5, 2771, -683, 178.5, 6514, -4426, 181.5, 250, -8169, 184.5, 3993, -1905, 187.5, 7736, -5648, 190.5, 1472, -9391, 193.5, 5215, -3127, 196.5, 8958, -6870, 199.5
];
let sum = 0;
for (const v of NUMS) if (Number.isFinite(v)) sum += v;
console.log("nums", NUMS.length, sum, Object.is(NUMS[5], -0), NUMS[6], NUMS[7], NUMS[8], NUMS[9], NUMS[199]);
const numsAlias = NUMS;
numsAlias[3] = 7.25;
numsAlias.push(-1);
console.log("nums mutated", NUMS[3], NUMS.length, NUMS[NUMS.length - 1], NUMS.indexOf(7.25), NUMS.includes(1e21));
console.log("nums methods", NUMS.slice(10, 14).join(","), NUMS.filter((v) => v < 0).length, Math.max(...NUMS.slice(10, 40)), [...NUMS.slice(10, 16)].sort((a, b) => a - b).join(","));
NUMS.length = 12;
console.log("nums truncated", NUMS.length, NUMS.join("|"));

const INTS: number[] = [
-2000, -1682, -1364, -1046, -728, -410, -92, 226, 544, 862, 1180, 1498, 1816, -1867, -1549, -1231, -913, -595, -277, 41, 359, 677, 995, 1313, 1631, 1949, -1734, -1416, -1098, -780, -462, -144, 174, 492, 810, 1128, 1446, 1764, -1919, -1601, -1283, -965, -647, -329, -11, 307, 625, 943, 1261, 1579, 1897, -1786, -1468, -1150, -832, -514, -196, 122, 440, 758, 1076, 1394, 1712, -1971, -1653, -1335, -1017, -699, -381, -63, 255, 573, 891, 1209, 1527, 1845, -1838, -1520, -1202, -884, -566, -248, 70, 388, 706, 1024, 1342, 1660, 1978, -1705, -1387, -1069, -751, -433, -115, 203, 521, 839, 1157, 1475, 1793, -1890, -1572, -1254, -936, -618, -300, 18, 336, 654, 972, 1290, 1608, 1926, -1757, -1439, -1121, -803, -485, -167
];
let intSum = 0;
for (let i = 0; i < INTS.length; i++) intSum += INTS[i];
INTS.forEach((v) => { intSum += v & 3; });
console.log("ints", INTS.length, intSum, INTS[0], INTS[119]);
INTS[2] = 0.5;
INTS.unshift(2 ** 40);
console.log("ints mutated", INTS[0], INTS[3], INTS.length, INTS.reduce((a, b) => a + b, 0));

const NANS: number[] = [
NaN, 1, NaN, 3, NaN, 5, NaN, 7, NaN, 9, NaN, 11, NaN, 13, NaN, 15, NaN, 17, NaN, 19, NaN, 21, NaN, 23, NaN, 25, NaN, 27, NaN, 29, NaN, 31, NaN, 33, NaN, 35, NaN, 37, NaN, 39, NaN, 41, NaN, 43, NaN, 45, NaN, 47, NaN, 49, NaN, 51, NaN, 53, NaN, 55, NaN, 57, NaN, 59, NaN, 61, NaN, 63, NaN, 65, NaN, 67, NaN, 69
];
NANS.push(1);
console.log("nans", NANS.length, NANS.filter((v) => v !== v).length, NANS.includes(NaN), NANS.indexOf(NaN));

const WORDS: string[] = [
"dup", "word-1", "word-2", "", "", "word-5", "word-6", "word-7", "word-8", "word-9", "word-10", "dup", "word-12", "word-13", "word-14", "word-15", "word-16", "word-17", "word-18", "word-19", "word-20", "word-21", "dup", "word-23", "word-24", "word-25", "word-26", "word-27", "word-28", "word-29", "😀 smile", "tab\there", "word-32", "dup", "word-34", "word-35", "word-36", "word-37", "word-38", "word-39", "word-40", "word-41", "word-42", "word-43", "dup", "word-45", "word-46", "word-47", "word-48", "word-49", "word-50", "word-51", "word-52", "word-53", "word-54", "dup", "word-56", "word-57", "word-58", "word-59", "word-60", "word-61", "word-62", "word-63", "word-64", "word-65", "dup", "word-67", "word-68", "word-69", "word-70", "word-71", "word-72", "word-73", "word-74", "word-75", "word-76", "dup", "word-78", "word-79", "word-80", "word-81", "word-82", "word-83", "word-84", "word-85", "word-86", "word-87", "dup", "word-89", "word-90", "word-91", "word-92", "word-93", "word-94", "word-95", "word-96", "word-97", "word-98", "dup", "word-100", "word-101", "word-102", "word-103", "word-104", "word-105", "word-106", "word-107", "word-108", "word-109", "dup", "word-111", "word-112", "word-113", "word-114", "word-115", "word-116", "word-117", "word-118", "word-119", "word-120", "dup", "word-122", "word-123", "word-124", "word-125", "word-126", "word-127", "word-128", "word-129", "word-130", "word-131", "dup", "word-133", "word-134", "word-135", "word-136", "word-137", "word-138", "word-139", "word-140", "word-141", "word-142", "dup", "word-144", "word-145", "word-146", "word-147", "word-148", "word-149"
];
console.log("words", WORDS.length, WORDS[0], WORDS[3].length, WORDS[30], WORDS[30].length, WORDS[31], WORDS[149]);
console.log("words dup", WORDS[11] === WORDS[22], WORDS.filter((w) => w === "dup").length, WORDS.indexOf("dup"), WORDS.lastIndexOf("dup"));
const wordsAlias = WORDS;
wordsAlias[1] = "changed";
wordsAlias.push("pushed");
console.log("words mutated", WORDS[1], WORDS.length, WORDS[WORDS.length - 1], WORDS.includes("word-1"));
console.log("words methods", [...WORDS].sort().slice(0, 4).join(","), WORDS.map((w) => w.length).reduce((a, b) => a + b, 0), WORDS.slice(5, 8).join("+"));

const FLAGS: boolean[] = [
true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false, true, false, false, true, false
];
FLAGS[0] = !FLAGS[0];
console.log("flags", FLAGS.length, FLAGS.filter((f) => f).length, FLAGS[0], FLAGS[1], FLAGS[99]);

const MIXED: (number | string)[] = [
0, "s1", 2, "s3", 4, "s5", 6, "s7", 8, "s9", 10, "s11", 12, "s13", 14, "s15", 16, "s17", 18, "s19", 20, "s21", 22, "s23", 24, "s25", 26, "s27", 28, "s29", 30, "s31", 32, "s33", 34, "s35", 36, "s37", 38, "s39", 40, "s41", 42, "s43", 44, "s45", 46, "s47", 48, "s49", 50, "s51", 52, "s53", 54, "s55", 56, "s57", 58, "s59", 60, "s61", 62, "s63", 64, "s65", 66, "s67", 68, "s69", 70, "s71", 72, "s73", 74, "s75", 76, "s77", 78, "s79", 80, "s81", 82, "s83", 84, "s85", 86, "s87", 88, "s89", 90, "s91", 92, "s93", 94, "s95", 96, "s97", 98, "s99"
];
console.log("mixed", MIXED.length, MIXED.filter((v) => typeof v === "string").length, MIXED[0], MIXED[1], MIXED[99]);

const NULLABLE: (number | null)[] = [
0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 162, 165, 168, 171, 174, 177, 180, 183, 186, 189, 192, 195, 198, 201, 204, 207, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 7, null
];
NULLABLE[1] = null;
let nulls = 0;
for (const v of NULLABLE) if (v === null) nulls++;
console.log("nullable", NULLABLE.length, nulls, NULLABLE[0], NULLABLE[1], NULLABLE[69], NULLABLE[70], NULLABLE[140], NULLABLE[141]);

const GRID: number[][] = [
[0, 0, 0], [1, -1, 0.5], [2, -2, 1], [3, -3, 1.5], [4, -4, 2], [5, -5, 2.5], [6, -6, 3], [7, -7, 3.5], [8, -8, 4], [9, -9, 4.5], [10, -10, 5], [11, -11, 5.5], [12, -12, 6], [13, -13, 6.5], [14, -14, 7], [15, -15, 7.5], [16, -16, 8], [17, -17, 8.5], [18, -18, 9], [19, -19, 9.5], [20, -20, 10], [21, -21, 10.5], [22, -22, 11], [23, -23, 11.5], [24, -24, 12], [25, -25, 12.5], [26, -26, 13], [27, -27, 13.5], [28, -28, 14], [29, -29, 14.5], [30, -30, 15], [31, -31, 15.5], [32, -32, 16], [33, -33, 16.5], [34, -34, 17], [35, -35, 17.5], [36, -36, 18], [37, -37, 18.5], [38, -38, 19], [39, -39, 19.5], [40, -40, 20], [41, -41, 20.5], [42, -42, 21], [43, -43, 21.5], [44, -44, 22], [45, -45, 22.5], [46, -46, 23], [47, -47, 23.5], [48, -48, 24], [49, -49, 24.5], [50, -50, 25], [51, -51, 25.5], [52, -52, 26], [53, -53, 26.5], [54, -54, 27], [55, -55, 27.5], [56, -56, 28], [57, -57, 28.5], [58, -58, 29], [59, -59, 29.5], [60, -60, 30], [61, -61, 30.5], [62, -62, 31], [63, -63, 31.5], [64, -64, 32], [65, -65, 32.5], [66, -66, 33], [67, -67, 33.5], [68, -68, 34], [69, -69, 34.5], [70, -70, 35], [71, -71, 35.5], [72, -72, 36], [73, -73, 36.5], [74, -74, 37], [75, -75, 37.5], [76, -76, 38], [77, -77, 38.5], [78, -78, 39], [79, -79, 39.5], [80, -80, 40], [81, -81, 40.5], [82, -82, 41], [83, -83, 41.5], [84, -84, 42], [85, -85, 42.5], [86, -86, 43], [87, -87, 43.5], [88, -88, 44], [89, -89, 44.5], [90, -90, 45], [91, -91, 45.5], [92, -92, 46], [93, -93, 46.5], [94, -94, 47], [95, -95, 47.5], [96, -96, 48], [97, -97, 48.5], [98, -98, 49], [99, -99, 49.5]
];
GRID[1][0] = 9;
GRID[3].push(4);
console.log("grid", GRID.length, GRID[1].join(","), GRID[2].join(","), GRID[3].length, GRID[4].length, GRID[0] === GRID[0], GRID[5] === GRID[6], Object.is(GRID[0][1], -0));

const JAGGED: number[][] = [
[], [1], [2, 3], [3, 4, 5], [], [5], [6, 7], [7, 8, 9], [], [9], [10, 11], [11, 12, 13], [], [13], [14, 15], [15, 16, 17], [], [17], [18, 19], [19, 20, 21], [], [21], [22, 23], [23, 24, 25], [], [25], [26, 27], [27, 28, 29], [], [29], [30, 31], [31, 32, 33], [], [33], [34, 35], [35, 36, 37], [], [37], [38, 39], [39, 40, 41], [], [41], [42, 43], [43, 44, 45], [], [45], [46, 47], [47, 48, 49], [], [49], [50, 51], [51, 52, 53], [], [53], [54, 55], [55, 56, 57], [], [57], [58, 59], [59, 60, 61], [], [61], [62, 63], [63, 64, 65], [], [65], [66, 67], [67, 68, 69], [], [69], [70, 71], [71, 72, 73], [], [73], [74, 75], [75, 76, 77], [], [77], [78, 79], [79, 80, 81], [], [81], [82, 83], [83, 84, 85], [], [85], [86, 87], [87, 88, 89], [], [89], [90, 91], [91, 92, 93], [], [93], [94, 95], [95, 96, 97], [], [97], [98, 99], [99, 100, 101]
];
console.log("jagged", JAGGED.length, JAGGED.reduce((a, r) => a + r.length, 0), JAGGED[7].join(","));

const HOLEY = [
0, 1, , 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, , 81, 82, 83, 84, 85, 86, 87, 88, 89
];
let present = 0;
HOLEY.forEach(() => { present++; });
console.log("holes", HOLEY.length, present, 2 in HOLEY, 3 in HOLEY, 80 in HOLEY, HOLEY[2], HOLEY[80], HOLEY[81]);

const MEMBERS = new Set<string>([
"member-0", "member-1", "member-2", "member-3", "member-4", "member-5", "member-6", "member-7", "member-8", "again", "member-10", "member-11", "member-12", "member-13", "member-14", "member-15", "member-16", "member-17", "member-18", "again", "member-20", "member-21", "member-22", "member-23", "member-24", "member-25", "member-26", "member-27", "member-28", "again", "member-30", "member-31", "member-32", "member-33", "member-34", "member-35", "member-36", "member-37", "member-38", "again", "member-40", "member-41", "member-42", "member-43", "member-44", "member-45", "member-46", "member-47", "member-48", "again", "member-50", "member-51", "member-52", "member-53", "member-54", "member-55", "member-56", "member-57", "member-58", "again", "member-60", "member-61", "member-62", "member-63", "member-64", "member-65", "member-66", "member-67", "member-68", "again", "member-70", "member-71", "member-72", "member-73", "member-74", "member-75", "member-76", "member-77", "member-78", "again", "member-80", "member-81", "member-82", "member-83", "member-84", "member-85", "member-86", "member-87", "member-88", "again", "member-90", "member-91", "member-92", "member-93", "member-94", "member-95", "member-96", "member-97", "member-98", "again", "member-100", "member-101", "member-102", "member-103", "member-104", "member-105", "member-106", "member-107", "member-108", "again", "member-110", "member-111", "member-112", "member-113", "member-114", "member-115", "member-116", "member-117", "member-118", "again"
]);
MEMBERS.delete("member-1");
MEMBERS.add("late");
const firstMembers: string[] = [];
for (const m of MEMBERS) if (firstMembers.length < 4) firstMembers.push(m);
console.log("set", MEMBERS.size, MEMBERS.has("again"), MEMBERS.has("member-1"), MEMBERS.has("member-118"), firstMembers.join(","));

const PAIRS = new Map<string, number>([
["key-0", 0], ["key-1", 2], ["key-2", 4], ["key-3", 6], ["key-4", 8], ["key-5", 10], ["key-6", 12], ["key-7", 14], ["key-8", 16], ["key-9", 18], ["key-10", 20], ["key-11", 22], ["key-12", 24], ["key-13", 26], ["key-14", 28], ["key-15", 30], ["key-16", 32], ["key-17", 34], ["key-18", 36], ["key-19", 38], ["key-20", 40], ["key-21", 42], ["key-22", 44], ["key-23", 46], ["key-24", 48], ["key-25", 50], ["key-26", 52], ["key-27", 54], ["key-28", 56], ["key-29", 58], ["key-30", 60], ["key-31", 62], ["key-32", 64], ["key-33", 66], ["key-34", 68], ["key-35", 70], ["key-36", 72], ["key-37", 74], ["key-38", 76], ["key-39", 78], ["key-40", 80], ["key-41", 82], ["key-42", 84], ["key-43", 86], ["key-44", 88], ["key-45", 90], ["key-46", 92], ["key-47", 94], ["key-48", 96], ["key-49", 98], ["key-50", 100], ["key-51", 102], ["key-52", 104], ["key-53", 106], ["key-54", 108], ["key-55", 110], ["key-56", 112], ["key-57", 114], ["key-58", 116], ["key-59", 118], ["key-60", 120], ["key-61", 122], ["key-62", 124], ["key-63", 126], ["key-64", 128], ["key-65", 130], ["key-66", 132], ["key-67", 134], ["key-68", 136], ["key-69", 138], ["key-3", 140], ["key-71", 142], ["key-72", 144], ["key-73", 146], ["key-74", 148], ["key-75", 150], ["key-76", 152], ["key-77", 154], ["key-78", 156], ["key-79", 158], ["key-80", 160], ["key-81", 162], ["key-82", 164], ["key-83", 166], ["key-84", 168], ["key-85", 170], ["key-86", 172], ["key-87", 174], ["key-88", 176], ["key-89", 178], ["key-90", 180], ["key-91", 182], ["key-92", 184], ["key-93", 186], ["key-94", 188], ["key-95", 190], ["key-96", 192], ["key-97", 194], ["key-98", 196], ["key-99", 198], ["key-100", 200], ["key-101", 202], ["key-102", 204], ["key-103", 206], ["key-104", 208], ["key-105", 210], ["key-106", 212], ["key-107", 214], ["key-108", 216], ["key-109", 218]
]);
PAIRS.set("key-0", -5);
console.log("map", PAIRS.size, PAIRS.get("key-3"), PAIRS.get("key-0"), PAIRS.get("key-109"), PAIRS.has("key-70"), [...PAIRS.keys()].slice(0, 4).join(","));

const CODES: Record<string, number> = {
  "k0": 0,
  "k1": 1,
  "k2": 2,
  "k3": 3,
  "k4": 4,
  "k5": 5,
  "k6": 6,
  "k7": 7,
  "k8": 8,
  "k9": 9,
  "k10": 10,
  "k11": 11,
  "k12": 12,
  "k13": 13,
  "k14": 14,
  "k15": 15,
  "k16": 16,
  "k17": 17,
  "k18": 18,
  "k19": 19,
  "k20": 20,
  "k21": 21,
  "k22": 22,
  "k23": 23,
  "k24": 24,
  "k25": 25,
  "k26": 26,
  "k27": 27,
  "k28": 28,
  "k29": 29,
  "k30": 30,
  "k31": 31,
  "k32": 32,
  "k33": 33,
  "k34": 34,
  "k35": 35,
  "k36": 36,
  "k37": 37,
  "k38": 38,
  "k39": 39,
  "10": 40,
  "2": 41,
  "k42": 42,
  "k43": 43,
  "k44": 44,
  "k45": 45,
  "k46": 46,
  "k47": 47,
  "k48": 48,
  "k49": 49,
  "k50": 50,
  "k51": 51,
  "k52": 52,
  "k53": 53,
  "k54": 54,
  "k55": 55,
  "k56": 56,
  "k57": 57,
  "k58": 58,
  "k59": 59,
  "k60": 60,
  "k61": 61,
  "k62": 62,
  "k63": 63,
  "k64": 64,
  "k65": 65,
  "k66": 66,
  "k67": 67,
  "k68": 68,
  "k69": 69,
  "k70": 70,
  "k71": 71,
  "k72": 72,
  "k73": 73,
  "k74": 74,
  "k75": 75,
  "k76": 76,
  "k77": 77,
  "k78": 78,
  "k79": 79,
  "k80": 80,
  "k81": 81,
  "k82": 82,
  "k83": 83,
  "k84": 84,
  "k85": 85,
  "k86": 86,
  "k87": 87,
  "k88": 88,
  "k89": 89,
  "k90": 90,
  "k91": 91,
  "k92": 92,
  "k93": 93,
  "k94": 94,
  "k95": 95,
  "k96": 96,
  "k97": 97,
  "k98": 98,
  "k99": 99,
};
CODES["added"] = -1;
delete CODES["k5"];
console.log("dict", Object.keys(CODES).length, Object.keys(CODES).slice(0, 5).join(","), CODES["k7"], CODES["10"], "k5" in CODES, "k6" in CODES, CODES["added"]);
