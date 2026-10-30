// Casts of values nothing else holds yet: a parse result and a response
// body. They convert outright; the results are ordinary records.

type Point = { x: number; y: number };
type Doc = { title: string; points: Point[] };

const parsed = JSON.parse('{"title":"t","points":[{"x":1,"y":2},{"x":3,"y":4}]}') as Doc;
parsed.points[0]!.x = 10;
parsed.points.push({ x: 5, y: 6 });
console.log("parse", parsed.title, parsed.points.length, JSON.stringify(parsed.points[0]));

const again = JSON.parse('{"x":1,"y":2}') as Point;
const other = JSON.parse('{"x":1,"y":2}') as Point;
console.log("separate parses", again === other, again.x === other.x);

async function main(): Promise<void> {
  const body = (await new Response('{"title":"r","points":[{"x":7,"y":8}]}').json()) as Doc;
  body.points[0]!.y = 80;
  console.log("response", body.title, JSON.stringify(body.points));
}
main();
