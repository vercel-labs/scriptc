// Parsed values written to a nested array of a data-only interface that a class implements.
interface Spot { x: number; y: number }
class Pin implements Spot { x = 1; y = 2; }
const raw: any[][][] = JSON.parse('[[[{"x":3,"y":4}]],[[{"x":5,"y":6}]]]');
const grid: Spot[][][] = raw;
grid[1]!.push([new Pin()]);
console.log(grid.map((plane) => plane.map((row) => row.map((spot) => spot.x + spot.y).join(",")).join(";")).join("|"), grid[1]![1]![0] instanceof Pin);
