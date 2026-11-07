// A table of rows.
import { value001 } from "./m001.ts";

interface Row002 {
  id: number;
  name: string;
  weight: number;
  tags: string[];
}
const rows: Row002[] = [
  { id: 200, name: "india", weight: 9, tags: ["delta", "t0"] },
  { id: 201, name: "echo", weight: 12, tags: ["hotel", "t1"] },
  { id: 202, name: "alpha", weight: 15, tags: ["alpha", "t2"] },
  { id: 203, name: "hotel", weight: 18, tags: ["echo", "t3"] },
  { id: 204, name: "delta", weight: 21, tags: ["india", "t0"] },
  { id: 205, name: "kilo", weight: 24, tags: ["bravo", "t1"] },
  { id: 206, name: "golf", weight: 27, tags: ["golf", "t2"] },
  { id: 207, name: "bravo", weight: 30, tags: ["kilo", "t3"] },
  { id: 208, name: "india", weight: 33, tags: ["delta", "t0"] },
  { id: 209, name: "echo", weight: 36, tags: ["hotel", "t1"] },
  { id: 210, name: "alpha", weight: 39, tags: ["alpha", "t2"] },
  { id: 211, name: "hotel", weight: 1, tags: ["echo", "t3"] },
];
let weight = 0;
for (const row of rows) weight += row.weight + row.tags.length + row.name.length;
const own = weight;

export const value002: number = (own + value001) % 1000003;
