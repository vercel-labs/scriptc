// Async application code: request handlers awaiting cached and computed
// values, Promise.all fan-out, and sequential awaits in loops.
interface User {
  id: number;
  name: string;
  score: number;
}

const cache = new Map<number, User>();
async function loadUser(id: number): Promise<User> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const user = { id, name: "user-" + id, score: (id * 37) % 101 };
  cache.set(id, user);
  return user;
}
async function authorize(user: User): Promise<boolean> {
  return user.score % 7 !== 0;
}
async function handle(requestId: number): Promise<number> {
  const user = await loadUser(requestId % 3000);
  if (!(await authorize(user))) return 0;
  const requests: Promise<User>[] = [loadUser((requestId + 1) % 3000), loadUser((requestId + 7) % 3000), loadUser((requestId + 13) % 3000)];
  const friends = await Promise.all(requests);
  let sum = user.score;
  for (const friend of friends) sum += friend.score;
  return sum;
}
async function batch(start: number, size: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < size; i++) total += await handle(start + i);
  return total;
}

async function main(): Promise<void> {
  const scale = Number(process.argv[2] ?? "1");
  const batches = Math.floor(200 * scale);
  let total = 0;
  for (let round = 0; round < batches; round += 10) {
    const work: Promise<number>[] = [];
    for (let b = 0; b < 10; b++) work.push(batch((round + b) * 100, 100));
    const results = await Promise.all(work);
    for (const r of results) total += r;
  }
  console.log("handled", batches * 100, "total", total);
}
void main();
