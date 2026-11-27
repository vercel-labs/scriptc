// read()'s size as a string goes through parseInt: a digit run too long for a
// double answers Infinity, which Node's computeNewHighWaterMark refuses with
// ERR_OUT_OF_RANGE, a negative Infinity reads nothing, and the parse stays
// linear in the string's length — a four-million-digit size is one scan, not a
// bignum multiply-add per digit.
import { Readable } from "node:stream";

const log = [];

/**
 * @param {string} label
 * @param {string | number | undefined} size
 */
function probe(label, size) {
  const stream = new Readable({ read() {} });
  stream.push("abcde");
  try {
    const chunk = stream.read(size);
    log.push(
      `${label} return ${chunk === null ? "null" : String(chunk)} left ${stream.readableLength}`,
    );
  } catch (error) {
    log.push(`${label} threw ${error.code} ${error.message}`);
  }
}

probe("digits 400", "9".repeat(400));
probe("digits 4m", "9".repeat(4000000));
probe("negative 400", "-" + "9".repeat(400));
probe("1GiB+1", "1073741825");
probe("1GiB", "1073741824");
probe("short 2", "2");
probe("absent", undefined);

console.log(log.join("\n"));
