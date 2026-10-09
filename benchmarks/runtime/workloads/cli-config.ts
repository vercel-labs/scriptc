// A short-running CLI: read a small JSON project manifest, validate it,
// resolve environment interpolation, order services into deployment waves,
// and print a plan summary. Each launch does little work, so process
// startup dominates; the runner times many launches.
import { readFileSync } from "node:fs";

interface EnvVar {
  name: string;
  value: string;
}
interface Route {
  path: string;
  methods: string[];
}
interface Service {
  name: string;
  image: string;
  replicas: number;
  port: number;
  cpu: number;
  memoryMb: number;
  dependsOn: string[];
  env: EnvVar[];
  routes: Route[];
}
interface Manifest {
  project: string;
  region: string;
  variables: EnvVar[];
  services: Service[];
}

function usage(message: string): never {
  process.stderr.write("deploy-plan: " + message + "\nusage: deploy-plan <manifest.json> [--env <name>] [--max-wave <n>]\n");
  process.exit(2);
}

const argv = process.argv.slice(2);
let file = "";
let envName = "staging";
let maxWave = 0;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--env" || arg === "--max-wave") {
    const value = argv[++i];
    if (value === undefined) usage(arg + " needs a value");
    else if (arg === "--env") envName = value;
    else maxWave = parseInt(value, 10);
  } else if (arg.startsWith("--")) usage("unknown flag " + arg);
  else file = arg;
}
if (file === "") usage("missing manifest path");

const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
const problems: string[] = [];
const warnings: string[] = [];

const variables = new Map<string, string>();
for (const v of manifest.variables) variables.set(v.name, v.value);
variables.set("ENV", envName);
variables.set("REGION", manifest.region);

function interpolate(service: string, text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("${", i);
    if (start < 0) {
      out += text.slice(i);
      break;
    }
    const end = text.indexOf("}", start);
    if (end < 0) {
      problems.push(service + ": unterminated interpolation in '" + text + "'");
      return text;
    }
    out += text.slice(i, start);
    const key = text.slice(start + 2, end);
    const value = variables.get(key);
    if (value === undefined) {
      warnings.push(service + ": undefined variable " + key);
    } else out += value;
    i = end + 1;
  }
  return out;
}

// Validation: unique names, ports, known dependencies, sane resources.
const byName = new Map<string, Service>();
const ports = new Map<number, string>();
for (const s of manifest.services) {
  if (byName.has(s.name)) problems.push("duplicate service " + s.name);
  byName.set(s.name, s);
  const owner = ports.get(s.port);
  if (owner !== undefined) problems.push(s.name + ": port " + s.port + " already used by " + owner);
  else ports.set(s.port, s.name);
  if (s.replicas < 1 || s.replicas > 50) warnings.push(s.name + ": unusual replica count " + s.replicas);
  if (s.memoryMb / s.cpu > 4096) warnings.push(s.name + ": memory/cpu ratio above 4 GiB per core");
}
for (const s of manifest.services)
  for (const dep of s.dependsOn)
    if (!byName.has(dep)) problems.push(s.name + ": depends on unknown service " + dep);

// Resolve environment values; count distinct resolved images.
const images = new Set<string>();
let envCount = 0;
for (const s of manifest.services) {
  images.add(interpolate(s.name, s.image));
  for (const v of s.env) {
    interpolate(s.name, v.value);
    envCount++;
  }
}

// Kahn's algorithm in name order: each wave holds services whose
// dependencies are all deployed by earlier waves.
const remaining = new Map<string, number>();
const dependents = new Map<string, string[]>();
for (const s of manifest.services) {
  remaining.set(s.name, s.dependsOn.filter((d) => byName.has(d)).length);
  for (const dep of s.dependsOn) {
    const list = dependents.get(dep) ?? [];
    list.push(s.name);
    dependents.set(dep, list);
  }
}
const waves: string[][] = [];
let ready = [...remaining].filter(([, n]) => n === 0).map(([name]) => name).sort();
while (ready.length > 0) {
  waves.push(ready);
  const next: string[] = [];
  for (const name of ready) {
    remaining.delete(name);
    for (const d of dependents.get(name) ?? []) {
      const left = (remaining.get(d) ?? 0) - 1;
      remaining.set(d, left);
      if (left === 0) next.push(d);
    }
  }
  ready = next.sort();
}
if (remaining.size > 0) problems.push("dependency cycle among: " + [...remaining.keys()].sort().join(", "));
if (maxWave > 0 && waves.length > maxWave) problems.push("plan needs " + waves.length + " waves, limit is " + maxWave);

// Route table: method counts and path conflicts across services.
const routeOwners = new Map<string, string>();
const methodCounts = new Map<string, number>();
for (const s of manifest.services)
  for (const r of s.routes)
    for (const m of r.methods) {
      const key = m + " " + r.path;
      const owner = routeOwners.get(key);
      if (owner !== undefined && owner !== s.name) problems.push("route " + key + " claimed by " + owner + " and " + s.name);
      routeOwners.set(key, s.name);
      methodCounts.set(m, (methodCounts.get(m) ?? 0) + 1);
    }

let cpu = 0;
let memory = 0;
let replicas = 0;
for (const s of manifest.services) {
  cpu += s.cpu * s.replicas;
  memory += s.memoryMb * s.replicas;
  replicas += s.replicas;
}

console.log("deploy plan for " + manifest.project + " (" + envName + ", " + manifest.region + ")");
console.log("services " + manifest.services.length + ", replicas " + replicas + ", images " + images.size + ", env vars " + envCount);
console.log("capacity " + cpu.toFixed(2) + " vCPU, " + (memory / 1024).toFixed(1) + " GiB");
console.log("routes " + routeOwners.size + " (" + [...methodCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([m, n]) => m + " " + n).join(", ") + ")");
for (let w = 0; w < waves.length; w++) {
  const wave = waves[w]!;
  const shown = wave.slice(0, 6).join(" ");
  console.log("wave " + (w + 1) + ": " + wave.length + " services  " + shown + (wave.length > 6 ? " ..." : ""));
}
console.log("warnings " + warnings.length);
for (const w of warnings.slice(0, 5)) console.log("  " + w);
if (problems.length > 0) {
  console.log("problems " + problems.length);
  for (const p of problems.slice(0, 10)) console.log("  " + p);
  process.exitCode = 1;
} else console.log("ok");
