const fs = require('fs');

/**
 * Replace any characters that can't be sent on with an underscore
 */
function sanitizeTags(value, telegraf) {
  const blacklist = telegraf ? /:|\||,/g : /:|\||@|,/g;
  // Replace reserved chars with underscores.
  return String(value).replace(blacklist, '_');
}

/**
 * Format tags properly before sending on
 */
function formatTags(tags, telegraf) {
  if (Array.isArray(tags)) {
    return tags;

  } else {
    return Object.keys(tags).map(key => {
      return `${sanitizeTags(key, telegraf)}:${sanitizeTags(tags[key], telegraf)}`;
    });
  }
}

/**
 * Overrides tags in parent with tags from child with the same name (case sensitive) and return the result as new
 * array. parent and child are not mutated.
 */
function overrideTags (parent, child, telegraf) {
  const childCopy = {};
  const toAppend = [];
  formatTags(child, telegraf).forEach(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) { // Not found or first character
      toAppend.push(tag);
    } else {
      const key = tag.substring(0, idx);
      const value = tag.substring(idx + 1);
      childCopy[key] = childCopy[key] || [];
      childCopy[key].push(value);
    }
  });
  const result = parent.filter(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) { // Not found or first character
      return true;
    }

    const key = tag.substring(0, idx);

    return !childCopy.hasOwnProperty(key);
  });

  Object.keys(childCopy).forEach(key => {
    for (const value of childCopy[key]) {
      result.push(`${key}:${value}`);
    }
  });
  return result.concat(toAppend);
}

/**
 * Formats a date for use with DataDog
 */
function formatDate(date) {
  let timestamp;
  if (date instanceof Date) {
    // Datadog expects seconds.
    timestamp = Math.round(date.getTime() / 1000);
  } else if (date instanceof Number || typeof date === 'number') {
    // Make sure it is an integer, not a float.
    timestamp = Math.round(date);
  }
  return timestamp;
}

/**
 * Converts int to a string IP
 */
function intToIP(int) {
  const part1 = int & 255;
  const part2 = ((int >> 8) & 255);
  const part3 = ((int >> 16) & 255);
  const part4 = ((int >> 24) & 255);

  return `${part4}.${part3}.${part2}.${part1}`;
}

/**
 * Returns the system default interface on Linux
 */
function getDefaultRoute() {
  try {
    const fileContents = fs.readFileSync('/proc/net/route', 'utf8'); // eslint-disable-line no-sync
    const routes = fileContents.split('\n');
    for (const routeIdx in routes) {
      const fields = routes[routeIdx].trim().split('\t');
      if (fields[1] === '00000000') {
        const address = fields[2];
        // Convert to little endian by splitting every 2 digits and reversing that list
        const littleEndianAddress = address.match(/.{2}/g).reverse().join('');
        return intToIP(parseInt(littleEndianAddress, 16));
      }
    }
  } catch (e) {
    console.error('Could not get default route from /proc/net/route');
  }
  return null;
}

module.exports = {
  formatTags: formatTags,
  overrideTags: overrideTags,
  formatDate: formatDate,
  getDefaultRoute: getDefaultRoute,
  sanitizeTags: sanitizeTags
};
