// A package without declarations, typed by a local declaration file
// (scriptc.typePatches types): user code is checked against it, and the
// values cross the declaration boundary as native records.
import { centroid, point, type Point } from "pointjs";

const points: Point[] = [point(0, 0), point(4, 0), point(4, 3)];
const c = centroid(points);
console.log(c === null ? "none" : `${c.x.toFixed(2)},${c.y.toFixed(2)}`);
console.log(centroid([]) === null, JSON.stringify(points.map((p) => p.x + p.y)));
