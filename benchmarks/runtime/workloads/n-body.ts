// n-body: the outer planets advanced by a fixed step, then the system's total
// energy. Five bodies in an array of records, the pair loop over the upper
// triangle that each step reads and writes, and two reduction passes over the
// same records.

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
}

const PI = 3.141592653589793;
const SOLAR_MASS = 4 * PI * PI;
const DAYS_PER_YEAR = 365.24;

function sun(): Body {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: SOLAR_MASS };
}

function jupiter(): Body {
  return {
    x: 4.8414314424647209,
    y: -1.16032004402742839,
    z: -1.03622044471123109e-1,
    vx: 1.66007664274403694e-3 * DAYS_PER_YEAR,
    vy: 7.69901118419740425e-3 * DAYS_PER_YEAR,
    vz: -6.90460016972063023e-5 * DAYS_PER_YEAR,
    mass: 9.54791938424326609e-4 * SOLAR_MASS,
  };
}

function saturn(): Body {
  return {
    x: 8.34336671824457987,
    y: 4.12479856412430479,
    z: -4.03523417114321381e-1,
    vx: -2.76742510726862411e-3 * DAYS_PER_YEAR,
    vy: 4.99852801234917238e-3 * DAYS_PER_YEAR,
    vz: 2.30417297573763929e-5 * DAYS_PER_YEAR,
    mass: 2.85885980666130812e-4 * SOLAR_MASS,
  };
}

function uranus(): Body {
  return {
    x: 1.2894369562139131e1,
    y: -1.51111514016986312e1,
    z: -2.23307578892655734e-1,
    vx: 2.96460137564761618e-3 * DAYS_PER_YEAR,
    vy: 2.3784717395948095e-3 * DAYS_PER_YEAR,
    vz: -2.96589568540237556e-5 * DAYS_PER_YEAR,
    mass: 4.36624404335156298e-5 * SOLAR_MASS,
  };
}

function neptune(): Body {
  return {
    x: 1.53796971148509165e1,
    y: -2.59193146099879641e1,
    z: 1.79258772950371181e-1,
    vx: 2.68067772490389322e-3 * DAYS_PER_YEAR,
    vy: 1.62824170038242295e-3 * DAYS_PER_YEAR,
    vz: -9.5159225451971587e-5 * DAYS_PER_YEAR,
    mass: 5.15138902046611451e-5 * SOLAR_MASS,
  };
}

function offsetMomentum(bodies: Body[], n: number): void {
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < n; i++) {
    const b = bodies[i]!;
    px += b.vx * b.mass;
    py += b.vy * b.mass;
    pz += b.vz * b.mass;
  }
  bodies[0]!.vx = -px / SOLAR_MASS;
  bodies[0]!.vy = -py / SOLAR_MASS;
  bodies[0]!.vz = -pz / SOLAR_MASS;
}

function energy(bodies: Body[], n: number): number {
  let e = 0;
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]!;
    e += 0.5 * bi.mass * (bi.vx * bi.vx + bi.vy * bi.vy + bi.vz * bi.vz);
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j]!;
      const dx = bi.x - bj.x;
      const dy = bi.y - bj.y;
      const dz = bi.z - bj.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      e -= (bi.mass * bj.mass) / d;
    }
  }
  return e;
}

function advance(bodies: Body[], n: number, dt: number): void {
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]!;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j]!;
      const dx = bi.x - bj.x;
      const dy = bi.y - bj.y;
      const dz = bi.z - bj.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const mag = dt / (d2 * Math.sqrt(d2));
      bi.vx -= dx * bj.mass * mag;
      bi.vy -= dy * bj.mass * mag;
      bi.vz -= dz * bj.mass * mag;
      bj.vx += dx * bi.mass * mag;
      bj.vy += dy * bi.mass * mag;
      bj.vz += dz * bi.mass * mag;
    }
    bi.x += dt * bi.vx;
    bi.y += dt * bi.vy;
    bi.z += dt * bi.vz;
  }
}

const scale = Number(process.argv[2] ?? "1");
const steps = Math.floor(1000000 * scale);
const bodies: Body[] = [sun(), jupiter(), saturn(), uranus(), neptune()];
offsetMomentum(bodies, bodies.length);
const start = energy(bodies, bodies.length);
for (let s = 0; s < steps; s++) advance(bodies, bodies.length, 0.01);
const end = energy(bodies, bodies.length);
console.log("energy", start.toFixed(9), end.toFixed(9));
