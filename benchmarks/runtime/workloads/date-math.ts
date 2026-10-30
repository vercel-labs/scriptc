// Calendar arithmetic on Dates: schedules built by adjusting Dates with the
// UTC and local setters, weekday and month-end rules read back through the
// getters, Dates compared and sorted by time value, and ISO text for a
// sample. Argument: the number of rounds.
process.env.TZ = "America/New_York";

const rounds = Number(process.argv[2] ?? "40");
let seed = 2026;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

/** The next business day at 09:00 local time on or after `from`. */
function nextBusinessDay(from: Date): Date {
  const day = new Date(from.getTime());
  day.setHours(9, 0, 0, 0);
  if (day < from) day.setDate(day.getDate() + 1);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
  return day;
}

/** The last day of `date`'s month, in UTC. */
function monthEnd(date: Date): number {
  const end = new Date(date.getTime());
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.getUTCDate();
}

let checksum = 0;
let sample = "";
for (let round = 0; round < rounds; round++) {
  const due: Date[] = [];
  const cursor = new Date(Date.UTC(2020 + (round % 7), 0, 1, 12));
  for (let i = 0; i < 4000; i++) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + Math.floor(random() * 4000));
    const next = nextBusinessDay(cursor);
    checksum += next.getDate() + monthEnd(next) + next.getHours();
    if (i % 3 === 0) next.setMonth(next.getMonth() + 1, 15);
    due.push(next);
  }
  due.sort((a, b) => +a - +b);
  let previous = due[0]!;
  for (const date of due) {
    checksum += (+date - +previous) / 3600000;
    previous = date;
  }
  sample = due[due.length >> 1]!.toISOString();
}
console.log(Math.round(checksum), sample);
