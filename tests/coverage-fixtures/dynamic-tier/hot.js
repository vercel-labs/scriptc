// Untyped JavaScript whose functions loop over their arguments: the build
// names them (SC6101). `scale` runs once and stays quiet.
function scale(points, factor) {
  return { points, factor };
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function spread(points) {
  const c = centroid(points);
  let total = 0;
  for (let i = 0; i < points.length; i++) total += distance(points[i], c);
  return total;
}

const points = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 0, y: 3 },
];
const scaled = scale(points, 2);
console.log(scaled.factor, spread(points).toFixed(3));
