// A namespace-style library in the pre-module idiom (guarded namespace
// declarations, constructor functions with prototype methods, enums as
// objects, a revealing module, a handler registry, exported through
// `module.exports = { app }`), used from TypeScript.
import { app } from "legacy-ns";

const v = new app.geom.Vec(3, 4);
console.log(v.length(), v.add(new app.geom.Vec(1, 1)).scale(2).x, v instanceof app.geom.Vec);
console.log(Object.keys(app).join(","), Object.keys(app.math).join(","), Object.keys(app.geom.Kind).join(","));
console.log(app.math.clamp(12, 0, 10), app.math.lerp(0, 10, 0.25), app.text.pad(7, 3), app.text.label(1, 42));

const shapes = [];
for (let i = 0; i < 12; i++) {
  const center = new app.geom.Vec(app.math.lerp(-5, 5, (i % 4) / 3), app.math.lerp(-5, 5, Math.floor(i / 4) / 2));
  shapes.push(new app.geom.Shape(i % 3, center, 1 + (i % 4)));
}
let area = 0;
let hits = 0;
for (let step = 0; step < 200; step++) {
  const probe = new app.geom.Vec(app.math.clamp(Math.sin(step) * 7, -5, 5), app.math.clamp(Math.cos(step * 0.7) * 7, -5, 5));
  for (const s of shapes) {
    area += app.registry.run("area", s, probe);
    hits += app.registry.run("hits", s, probe);
  }
}
console.log(Math.round(area), hits, shapes[4].contains(shapes[4].center), shapes[0].area());
