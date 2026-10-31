// The project's declarations for pointjs, which ships none.
export type Point = { x: number; y: number };
export declare function point(x: number, y: number): Point;
export declare function centroid(points: Point[]): Point | null;
