// Validation layers that throw and catch errors for a fraction of inputs,
// with deep call chains of small functions on the success path.
class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}
interface Signup {
  email: string;
  age: number;
  name: string;
  password: string;
}

let seed = 8080;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
function makeSignup(i: number): Signup {
  const bad = random();
  return {
    email: bad < 0.05 ? "broken" : `user${i}@example.com`,
    age: bad > 0.97 ? -1 : 18 + Math.floor(random() * 60),
    name: bad > 0.95 && bad <= 0.97 ? "  " : "Name " + i,
    password: random() < 0.03 ? "short" : "correct horse battery " + i,
  };
}

function requireText(field: string, value: string, min: number): string {
  if (value.length < min) throw new ValidationError(field, `${field} must have at least ${min} characters`);
  return value;
}
function requireEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0 || value.indexOf(".", at) < 0) throw new ValidationError("email", "invalid email");
  return value.toLowerCase();
}
function requireRange(field: string, value: number, min: number, max: number): number {
  if (value < min || value > max) throw new ValidationError(field, `${field} out of range`);
  return value;
}
function normalize(input: Signup): Signup {
  return {
    email: requireEmail(input.email),
    age: requireRange("age", input.age, 13, 120),
    name: requireText("name", input.name.trim(), 1),
    password: requireText("password", input.password, 8),
  };
}
function score(s: Signup): number {
  return s.email.length + s.age + s.name.length + s.password.length;
}

const scale = Number(process.argv[2] ?? "1");
const inputs: Signup[] = [];
for (let i = 0; i < Math.floor(200000 * scale); i++) inputs.push(makeSignup(i));
const failures = new Map<string, number>();
let accepted = 0;
let total = 0;
for (let round = 0; round < 3; round++) {
  for (const input of inputs) {
    try {
      const s = normalize(input);
      accepted++;
      total += score(s);
    } catch (error) {
      if (error instanceof ValidationError) failures.set(error.field, (failures.get(error.field) ?? 0) + 1);
      else throw error;
    }
  }
}
console.log("accepted", accepted, "total", total);
for (const key of [...failures.keys()].sort()) console.log(key, failures.get(key));
