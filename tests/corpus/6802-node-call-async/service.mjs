export function weather(city) {
  return Promise.resolve({ city, temperature: 21.5, tags: ["sunny", "dry"] });
}

export function slow(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(`slept ${ms}`), ms));
}

export async function double(n) {
  return n * 2;
}

export function plain(n) {
  return n + 1;
}

export async function fails(why) {
  const error = new RangeError(`failed ${why}`);
  error.code = "ERR_FAILED";
  throw error;
}

export async function nothing() {}

export function later(ms) {
  setTimeout(() => console.log(`island timer after ${ms} ms`), ms);
}
