// A large literal table of records: the rows are built by a loop over
// constants in the program image, and must be the objects the literal makes.
interface Row { id: number; name: string; score: number; on: boolean; tags: string[]; note: string | null }
const ROWS: Row[] = [
  { id: 0, name: "repeat", score: 0, on: true, tags: ["t0", "u0"], note: null },
  { id: 1, name: "row-1", score: 0.25, on: false, tags: ["t1", "u1"], note: null },
  { id: 2, name: "row-2", score: 0.5, on: false, tags: ["t2", "u2"], note: null },
  { id: 3, name: "row-3", score: 0.75, on: true, tags: ["t3", "u3"], note: "note 3" },
  { id: 4, name: "row-4", score: -6, on: false, tags: ["t4", "u4"], note: "note 4" },
  { id: 5, name: "row-5", score: 1.25, on: false, tags: ["t0", "u5"], note: "note 5" },
  { id: 6, name: "row-6", score: 1.5, on: true, tags: ["t1", "u6"], note: "note 0" },
  { id: 7, name: "row-7", score: 1.75, on: false, tags: ["t2", "u0"], note: "note 1" },
  { id: 8, name: "row-8", score: -12, on: false, tags: ["t3", "u1"], note: "note 2" },
  { id: 9, name: "repeat", score: 2.25, on: true, tags: ["t4", "u2"], note: "note 3" },
  { id: 10, name: "row-10", score: 2.5, on: false, tags: ["t0", "u3"], note: "note 4" },
  { id: 11, name: "", score: 2.75, on: false, tags: ["t1", "u4"], note: "note 5" },
  { id: 12, name: "café 日本 😀", score: -18, on: true, tags: ["t2", "u5"], note: "note 0" },
  { id: 13, name: "q\"uote\\back\nline", score: 3.25, on: false, tags: ["t3", "u6"], note: "note 1" },
  { id: 14, name: "nul\u0000byte", score: 3.5, on: false, tags: ["t4", "u0"], note: "note 2" },
  { id: 15, name: "row-15", score: 3.75, on: true, tags: ["t0", "u1"], note: "note 3" },
  { id: 16, name: "row-16", score: -24, on: false, tags: ["t1", "u2"], note: "note 4" },
  { id: 17, name: "row-17", score: 4.25, on: false, tags: ["t2", "u3"], note: "note 5" },
  { id: 18, name: "repeat", score: 4.5, on: true, tags: ["t3", "u4"], note: "note 0" },
  { id: 19, name: "row-19", score: 4.75, on: false, tags: ["t4", "u5"], note: "note 1" },
  { id: 20, name: "row-20", score: -0, on: false, tags: ["t0", "u6"], note: "note 2" },
  { id: 21, name: "row-21", score: 5.25, on: true, tags: ["t1", "u0"], note: "note 3" },
  { id: 22, name: "row-22", score: 5.5, on: false, tags: ["t2", "u1"], note: "note 4" },
  { id: 23, name: "row-23", score: 5.75, on: false, tags: ["t3", "u2"], note: "note 5" },
  { id: 24, name: "row-24", score: -36, on: true, tags: ["t4", "u3"], note: "note 0" },
  { id: 25, name: "row-25", score: 6.25, on: false, tags: ["t0", "u4"], note: "note 1" },
  { id: 26, name: "row-26", score: 6.5, on: false, tags: ["t1", "u5"], note: "note 2" },
  { id: 27, name: "repeat", score: 6.75, on: true, tags: ["t2", "u6"], note: "note 3" },
  { id: 28, name: "row-28", score: -42, on: false, tags: ["t3", "u0"], note: "note 4" },
  { id: 29, name: "row-29", score: 7.25, on: false, tags: ["t4", "u1"], note: "note 5" },
  { id: 30, name: "row-30", score: 7.5, on: true, tags: ["t0", "u2"], note: "note 0" },
  { id: 31, name: "row-31", score: 7.75, on: false, tags: ["t1", "u3"], note: "note 1" },
  { id: 32, name: "row-32", score: -48, on: false, tags: ["t2", "u4"], note: "note 2" },
  { id: 33, name: "row-33", score: 8.25, on: true, tags: ["t3", "u5"], note: "note 3" },
  { id: 34, name: "row-34", score: 8.5, on: false, tags: ["t4", "u6"], note: "note 4" },
  { id: 35, name: "row-35", score: 8.75, on: false, tags: ["t0", "u0"], note: "note 5" },
  { id: 36, name: "repeat", score: -54, on: true, tags: ["t1", "u1"], note: "note 0" },
  { id: 37, name: "row-37", score: 9.25, on: false, tags: ["t2", "u2"], note: "note 1" },
  { id: 38, name: "row-38", score: 9.5, on: false, tags: ["t3", "u3"], note: "note 2" },
  { id: 39, name: "row-39", score: 9.75, on: true, tags: ["t4", "u4"], note: "note 3" },
  { id: 40, name: "row-40", score: -60, on: false, tags: ["t0", "u5"], note: "note 4" },
  { id: 41, name: "row-41", score: 10.25, on: false, tags: ["t1", "u6"], note: "note 5" },
  { id: 42, name: "row-42", score: 10.5, on: true, tags: ["t2", "u0"], note: "note 0" },
  { id: 43, name: "row-43", score: 10.75, on: false, tags: ["t3", "u1"], note: "note 1" },
  { id: 44, name: "row-44", score: -66, on: false, tags: ["t4", "u2"], note: "note 2" },
  { id: 45, name: "repeat", score: 11.25, on: true, tags: ["t0", "u3"], note: "note 3" },
  { id: 46, name: "row-46", score: 11.5, on: false, tags: ["t1", "u4"], note: "note 4" },
  { id: 47, name: "row-47", score: 11.75, on: false, tags: ["t2", "u5"], note: "note 5" },
  { id: 48, name: "row-48", score: -72, on: true, tags: ["t3", "u6"], note: "note 0" },
  { id: 49, name: "row-49", score: 12.25, on: false, tags: ["t4", "u0"], note: "note 1" },
  { id: 50, name: "row-50", score: 12.5, on: false, tags: ["t0", "u1"], note: "note 2" },
  { id: 51, name: "row-51", score: 12.75, on: true, tags: ["t1", "u2"], note: "note 3" },
  { id: 52, name: "row-52", score: -78, on: false, tags: ["t2", "u3"], note: "note 4" },
  { id: 53, name: "row-53", score: 13.25, on: false, tags: ["t3", "u4"], note: "note 5" },
  { id: 54, name: "repeat", score: 13.5, on: true, tags: ["t4", "u5"], note: "note 0" },
  { id: 55, name: "row-55", score: 13.75, on: false, tags: ["t0", "u6"], note: "note 1" },
  { id: 56, name: "row-56", score: -84, on: false, tags: ["t1", "u0"], note: "note 2" },
  { id: 57, name: "row-57", score: 14.25, on: true, tags: ["t2", "u1"], note: "note 3" },
  { id: 58, name: "row-58", score: 14.5, on: false, tags: ["t3", "u2"], note: "note 4" },
  { id: 59, name: "row-59", score: 14.75, on: false, tags: ["t4", "u3"], note: "note 5" },
  { id: 60, name: "row-60", score: -90, on: true, tags: ["t0", "u4"], note: "note 0" },
  { id: 61, name: "row-61", score: 15.25, on: false, tags: ["t1", "u5"], note: "note 1" },
  { id: 62, name: "row-62", score: 15.5, on: false, tags: ["t2", "u6"], note: "note 2" },
  { id: 63, name: "repeat", score: 15.75, on: true, tags: ["t3", "u0"], note: "note 3" },
  { id: 64, name: "row-64", score: -96, on: false, tags: ["t4", "u1"], note: "note 4" },
  { id: 65, name: "row-65", score: 16.25, on: false, tags: ["t0", "u2"], note: "note 5" },
  { id: 66, name: "row-66", score: 16.5, on: true, tags: ["t1", "u3"], note: "note 0" },
  { id: 67, name: "row-67", score: 16.75, on: false, tags: ["t2", "u4"], note: "note 1" },
  { id: 68, name: "row-68", score: -102, on: false, tags: ["t3", "u5"], note: "note 2" },
  { id: 69, name: "row-69", score: 17.25, on: true, tags: ["t4", "u6"], note: "note 3" },
  { id: 70, name: "row-70", score: 17.5, on: false, tags: ["t0", "u0"], note: "note 4" },
  { id: 71, name: "row-71", score: 17.75, on: false, tags: ["t1", "u1"], note: "note 5" },
  { id: 72, name: "repeat", score: -108, on: true, tags: ["t2", "u2"], note: "note 0" },
  { id: 73, name: "row-73", score: 18.25, on: false, tags: ["t3", "u3"], note: "note 1" },
  { id: 74, name: "row-74", score: 18.5, on: false, tags: ["t4", "u4"], note: "note 2" },
  { id: 75, name: "row-75", score: 18.75, on: true, tags: ["t0", "u5"], note: "note 3" },
  { id: 76, name: "row-76", score: -114, on: false, tags: ["t1", "u6"], note: "note 4" },
  { id: 77, name: "row-77", score: 19.25, on: false, tags: ["t2", "u0"], note: "note 5" },
  { id: 78, name: "row-78", score: 19.5, on: true, tags: ["t3", "u1"], note: "note 0" },
  { id: 79, name: "row-79", score: 19.75, on: false, tags: ["t4", "u2"], note: "note 1" },
  { id: 80, name: "row-80", score: -120, on: false, tags: ["t0", "u3"], note: "note 2" },
  { id: 81, name: "repeat", score: 20.25, on: true, tags: ["t1", "u4"], note: "note 3" },
  { id: 82, name: "row-82", score: 20.5, on: false, tags: ["t2", "u5"], note: "note 4" },
  { id: 83, name: "row-83", score: 20.75, on: false, tags: ["t3", "u6"], note: "note 5" },
  { id: 84, name: "row-84", score: -126, on: true, tags: ["t4", "u0"], note: "note 0" },
  { id: 85, name: "row-85", score: 21.25, on: false, tags: ["t0", "u1"], note: "note 1" },
  { id: 86, name: "row-86", score: 21.5, on: false, tags: ["t1", "u2"], note: "note 2" },
  { id: 87, name: "row-87", score: 21.75, on: true, tags: ["t2", "u3"], note: "note 3" },
  { id: 88, name: "row-88", score: -132, on: false, tags: ["t3", "u4"], note: "note 4" },
  { id: 89, name: "row-89", score: 22.25, on: false, tags: ["t4", "u5"], note: "note 5" },
  { id: 90, name: "repeat", score: 22.5, on: true, tags: ["t0", "u6"], note: "note 0" },
  { id: 91, name: "row-91", score: 22.75, on: false, tags: ["t1", "u0"], note: "note 1" },
  { id: 92, name: "row-92", score: -138, on: false, tags: ["t2", "u1"], note: "note 2" },
  { id: 93, name: "row-93", score: 23.25, on: true, tags: ["t3", "u2"], note: "note 3" },
  { id: 94, name: "row-94", score: 23.5, on: false, tags: ["t4", "u3"], note: "note 4" },
  { id: 95, name: "row-95", score: 23.75, on: false, tags: ["t0", "u4"], note: "note 5" },
  { id: 96, name: "row-96", score: -144, on: true, tags: ["t1", "u5"], note: "note 0" },
  { id: 97, name: "row-97", score: 24.25, on: false, tags: ["t2", "u6"], note: "note 1" },
  { id: 98, name: "row-98", score: 24.5, on: false, tags: ["t3", "u0"], note: "note 2" },
  { id: 99, name: "repeat", score: 24.75, on: true, tags: ["t4", "u1"], note: "note 3" },
  { id: 100, name: "row-100", score: -150, on: false, tags: ["t0", "u2"], note: "note 4" },
  { id: 101, name: "row-101", score: 25.25, on: false, tags: ["t1", "u3"], note: "note 5" },
  { id: 102, name: "row-102", score: 25.5, on: true, tags: ["t2", "u4"], note: "note 0" },
  { id: 103, name: "row-103", score: 25.75, on: false, tags: ["t3", "u5"], note: "alt 103" },
  { id: 104, name: "row-104", score: -156, on: false, tags: ["t4", "u6"], note: null },
  { id: 105, name: "row-105", score: 26.25, on: true, tags: ["t0", "u0"], note: "alt 105" },
  { id: 106, name: "row-106", score: 26.5, on: false, tags: ["t1", "u1"], note: null },
  { id: 107, name: "row-107", score: 26.75, on: false, tags: ["t2", "u2"], note: "alt 107" },
  { id: 108, name: "repeat", score: -162, on: true, tags: ["t3", "u3"], note: null },
  { id: 109, name: "row-109", score: 27.25, on: false, tags: ["t4", "u4"], note: "alt 109" },
  { id: 110, name: "row-110", score: 27.5, on: false, tags: ["t0", "u5"], note: null },
  { id: 111, name: "row-111", score: 27.75, on: true, tags: ["t1", "u6"], note: "alt 111" },
  { id: 112, name: "row-112", score: -168, on: false, tags: ["t2", "u0"], note: null },
  { id: 113, name: "row-113", score: 28.25, on: false, tags: ["t3", "u1"], note: "alt 113" },
  { id: 114, name: "row-114", score: 28.5, on: true, tags: ["t4", "u2"], note: null },
  { id: 115, name: "row-115", score: 28.75, on: false, tags: ["t0", "u3"], note: "alt 115" },
  { id: 116, name: "row-116", score: -174, on: false, tags: ["t1", "u4"], note: null },
  { id: 117, name: "repeat", score: 29.25, on: true, tags: ["t2", "u5"], note: "alt 117" },
  { id: 118, name: "row-118", score: 29.5, on: false, tags: ["t3", "u6"], note: null },
  { id: 119, name: "row-119", score: 29.75, on: false, tags: ["t4", "u0"], note: "alt 119" },
  { id: 120, name: "row-120", score: -180, on: true, tags: ["t0", "u1"], note: null },
  { id: 121, name: "row-121", score: 30.25, on: false, tags: ["t1", "u2"], note: "alt 121" },
  { id: 122, name: "row-122", score: 30.5, on: false, tags: ["t2", "u3"], note: null },
  { id: 123, name: "row-123", score: 30.75, on: true, tags: ["t3", "u4"], note: null },
  { id: 124, name: "row-124", score: -186, on: false, tags: ["t4", "u5"], note: null },
  { id: 125, name: "row-125", score: 31.25, on: false, tags: ["t0", "u6"], note: null },
  { id: 126, name: "repeat", score: 31.5, on: true, tags: ["t1", "u0"], note: null },
  { id: 127, name: "row-127", score: 31.75, on: false, tags: ["t2", "u1"], note: null },
  { id: 128, name: "row-128", score: -192, on: false, tags: ["t3", "u2"], note: null },
  { id: 129, name: "row-129", score: 32.25, on: true, tags: ["t4", "u3"], note: null },
  { id: 130, name: "row-130", score: 32.5, on: false, tags: ["t0", "u4"], note: null },
  { id: 131, name: "row-131", score: 32.75, on: false, tags: ["t1", "u5"], note: null },
  { id: 132, name: "row-132", score: -198, on: true, tags: ["t2", "u6"], note: null },
  { id: 133, name: "row-133", score: 33.25, on: false, tags: ["t3", "u0"], note: null },
  { id: 134, name: "row-134", score: 33.5, on: false, tags: ["t4", "u1"], note: null },
  { id: 135, name: "repeat", score: 33.75, on: true, tags: ["t0", "u2"], note: null },
  { id: 136, name: "row-136", score: -204, on: false, tags: ["t1", "u3"], note: null },
  { id: 137, name: "row-137", score: 34.25, on: false, tags: ["t2", "u4"], note: null },
  { id: 138, name: "row-138", score: 34.5, on: true, tags: ["t3", "u5"], note: null },
  { id: 139, name: "row-139", score: 34.75, on: false, tags: ["t4", "u6"], note: null },
  { id: 140, name: "row-140", score: -210, on: false, tags: ["t0", "u0"], note: null },
  { id: 141, name: "row-141", score: 35.25, on: true, tags: ["t1", "u1"], note: null },
  { id: 142, name: "row-142", score: 35.5, on: false, tags: ["t2", "u2"], note: null },
  { id: 143, name: "row-143", score: 35.75, on: false, tags: ["t3", "u3"], note: null },
  { id: 144, name: "repeat", score: -216, on: true, tags: ["t4", "u4"], note: null },
  { id: 145, name: "row-145", score: 36.25, on: false, tags: ["t0", "u5"], note: null },
  { id: 146, name: "row-146", score: 36.5, on: false, tags: ["t1", "u6"], note: null },
  { id: 147, name: "row-147", score: 36.75, on: true, tags: ["t2", "u0"], note: null },
  { id: 148, name: "row-148", score: -222, on: false, tags: ["t3", "u1"], note: null },
  { id: 149, name: "row-149", score: 37.25, on: false, tags: ["t4", "u2"], note: null },
  { id: 150, name: "row-150", score: 37.5, on: true, tags: ["t0", "u3"], note: null },
  { id: 151, name: "row-151", score: 37.75, on: false, tags: ["t1", "u4"], note: null },
  { id: 152, name: "row-152", score: -228, on: false, tags: ["t2", "u5"], note: null },
  { id: 153, name: "repeat", score: 38.25, on: true, tags: ["t3", "u6"], note: null },
  { id: 154, name: "row-154", score: 38.5, on: false, tags: ["t4", "u0"], note: null },
  { id: 155, name: "row-155", score: 38.75, on: false, tags: ["t0", "u1"], note: null },
  { id: 156, name: "row-156", score: -234, on: true, tags: ["t1", "u2"], note: null },
  { id: 157, name: "row-157", score: 39.25, on: false, tags: ["t2", "u3"], note: null },
  { id: 158, name: "row-158", score: 39.5, on: false, tags: ["t3", "u4"], note: null },
  { id: 159, name: "row-159", score: 39.75, on: true, tags: ["t4", "u5"], note: null },
  { id: 160, name: "row-160", score: -240, on: false, tags: ["t0", "u6"], note: null },
  { id: 161, name: "row-161", score: 40.25, on: false, tags: ["t1", "u0"], note: null },
  { id: 162, name: "repeat", score: 40.5, on: true, tags: ["t2", "u1"], note: null },
  { id: 163, name: "row-163", score: 40.75, on: false, tags: ["t3", "u2"], note: null },
  { id: 164, name: "row-164", score: -246, on: false, tags: ["t4", "u3"], note: null },
  { id: 165, name: "row-165", score: 41.25, on: true, tags: ["t0", "u4"], note: null },
  { id: 166, name: "row-166", score: 41.5, on: false, tags: ["t1", "u5"], note: null },
  { id: 167, name: "row-167", score: 41.75, on: false, tags: ["t2", "u6"], note: null },
  { id: 168, name: "row-168", score: -252, on: true, tags: ["t3", "u0"], note: null },
  { id: 169, name: "row-169", score: 42.25, on: false, tags: ["t4", "u1"], note: null },
  { id: 170, name: "row-170", score: 42.5, on: false, tags: ["t0", "u2"], note: null },
  { id: 171, name: "repeat", score: 42.75, on: true, tags: ["t1", "u3"], note: null },
  { id: 172, name: "row-172", score: -258, on: false, tags: ["t2", "u4"], note: null },
  { id: 173, name: "row-173", score: 43.25, on: false, tags: ["t3", "u5"], note: null },
  { id: 174, name: "row-174", score: 43.5, on: true, tags: ["t4", "u6"], note: null },
  { id: 175, name: "row-175", score: 43.75, on: false, tags: ["t0", "u0"], note: null },
  { id: 176, name: "row-176", score: -264, on: false, tags: ["t1", "u1"], note: null },
  { id: 177, name: "row-177", score: 44.25, on: true, tags: ["t2", "u2"], note: null },
  { id: 178, name: "row-178", score: 44.5, on: false, tags: ["t3", "u3"], note: null },
  { id: 179, name: "row-179", score: 44.75, on: false, tags: ["t4", "u4"], note: null },
  { id: 180, name: "repeat", score: -270, on: true, tags: ["t0", "u5"], note: null },
  { id: 181, name: "row-181", score: 45.25, on: false, tags: ["t1", "u6"], note: null },
  { id: 182, name: "row-182", score: 45.5, on: false, tags: ["t2", "u0"], note: null },
  { id: 183, name: "row-183", score: 45.75, on: true, tags: ["t3", "u1"], note: null },
  { id: 184, name: "row-184", score: -276, on: false, tags: ["t4", "u2"], note: null },
  { id: 185, name: "row-185", score: 46.25, on: false, tags: ["t0", "u3"], note: null },
  { id: 186, name: "row-186", score: 46.5, on: true, tags: ["t1", "u4"], note: null },
  { id: 187, name: "row-187", score: 46.75, on: false, tags: ["t2", "u5"], note: null },
  { id: 188, name: "row-188", score: -282, on: false, tags: ["t3", "u6"], note: null },
  { id: 189, name: "repeat", score: 47.25, on: true, tags: ["t4", "u0"], note: null },
  { id: 190, name: "row-190", score: 47.5, on: false, tags: ["t0", "u1"], note: null },
  { id: 191, name: "row-191", score: 47.75, on: false, tags: ["t1", "u2"], note: null },
  { id: 192, name: "row-192", score: -288, on: true, tags: ["t2", "u3"], note: null },
  { id: 193, name: "row-193", score: 48.25, on: false, tags: ["t3", "u4"], note: null },
  { id: 194, name: "row-194", score: 48.5, on: false, tags: ["t4", "u5"], note: null },
  { id: 195, name: "row-195", score: 48.75, on: true, tags: ["t0", "u6"], note: null },
  { id: 196, name: "row-196", score: -294, on: false, tags: ["t1", "u0"], note: null },
  { id: 197, name: "row-197", score: 49.25, on: false, tags: ["t2", "u1"], note: null },
  { id: 198, name: "repeat", score: 49.5, on: true, tags: ["t3", "u2"], note: null },
  { id: 199, name: "row-199", score: 49.75, on: false, tags: ["t4", "u3"], note: null },
  { id: 200, name: "row-200", score: -300, on: false, tags: ["t0", "u4"], note: null },
  { id: 201, name: "row-201", score: 50.25, on: true, tags: ["t1", "u5"], note: null },
  { id: 202, name: "row-202", score: 50.5, on: false, tags: ["t2", "u6"], note: null },
];

console.log("length", ROWS.length);
let total = 0;
for (const r of ROWS) total += r.score;
console.log("total", total);
console.log("reads", ROWS[0].name, ROWS[57].name, ROWS[202].tags.join("+"), ROWS[100].note, ROWS[2].note, ROWS[104].note, ROWS[105].note);
console.log("flags", ROWS[3].on, ROWS[4].on, ROWS.filter((r) => r.on).length);
console.log("strings", ROWS[11].name.length, ROWS[12].name, ROWS[12].name.length, ROWS[13].name, ROWS[14].name.length, ROWS[14].name.charCodeAt(3));
console.log("repeat", ROWS[9].name === ROWS[18].name, ROWS[9].name, ROWS.filter((r) => r.name === "repeat").length);
console.log("zero", Object.is(ROWS[20].score, -0), 1 / ROWS[20].score, Object.is(ROWS[0].score, -0), 1 / ROWS[0].score);
console.log("json", JSON.stringify(ROWS[2]), JSON.stringify(ROWS[120]), JSON.stringify(ROWS[150]));
console.log("keys", Object.keys(ROWS[1]).join(","));

// Every row is its own object, and so is every nested array.
console.log("identity", ROWS[3] === ROWS[3], ROWS[3] === ROWS[4], ROWS[3].tags === ROWS[3].tags, ROWS[3].tags === ROWS[4].tags, ROWS[150] === ROWS[151]);
console.log("frozen", Object.isFrozen(ROWS), Object.isFrozen(ROWS[0]), Object.isFrozen(ROWS[0].tags));

// The table looks constant, and is mutated through an alias.
const alias = ROWS;
const fifth = alias[5];
fifth.score = -1;
fifth.tags.push("extra");
fifth.name += "!";
console.log("mutated", ROWS[5].score, ROWS[5].tags.length, ROWS[5].name, ROWS[6].tags.length, ROWS[6].name);
alias.push({ id: 999, name: "added", score: 1, on: true, tags: [], note: null });
console.log("pushed", ROWS.length, ROWS[ROWS.length - 1].name);
ROWS[7] = ROWS[8];
console.log("stored", ROWS[7] === ROWS[8], ROWS[7].id);
function bump(table: Row[]): void { table[150].score += 1000; }
bump(ROWS);
console.log("passed", ROWS[150].score);

// Array methods see an ordinary array.
console.log("methods", ROWS.map((r) => r.id).slice(0, 5).join(","), ROWS.findIndex((r) => r.name === "row-42"), ROWS.indexOf(ROWS[9]), ROWS.includes(ROWS[10]), ROWS.some((r) => r.note === "alt 105"), ROWS.every((r) => r.tags.length >= 0));
const sorted = [...ROWS].sort((a, b) => b.score - a.score);
console.log("sorted", sorted[0].id, sorted[sorted.length - 1].id, ROWS[0].id);
ROWS.reverse();
console.log("reversed", ROWS[0].name, ROWS[ROWS.length - 1].name);
ROWS.reverse();
const removed = ROWS.splice(1, 2);
console.log("spliced", removed.length, removed[0].id, ROWS[1].id, ROWS.length);
ROWS.length = 4;
console.log("truncated", ROWS.length, ROWS[3].name);
Object.freeze(ROWS);
console.log("then frozen", Object.isFrozen(ROWS), Object.isFrozen(ROWS[0]));
