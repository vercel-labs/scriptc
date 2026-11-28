/**
 * An awaited async member is typed Promise<void>, and the value its body
 * answers is dropped where the async function is defined. The test would
 * read undefined where Node reads the fulfillment value, so the truthiness
 * test keeps the named refusal.
 */
const api = {
  /** @returns {Promise<void>} */
  async check() {
    return true;
  },
};

async function main() {
  if (await api.check()) console.log("yes");
  else console.log("no");
}

main();
