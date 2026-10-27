// A Date binding and parameter that the runtime-optional analysis would
// widen with an undefined arm (morgan's date token). Date values have no
// undefined-armed union, so the bindings keep their Date type.
'use strict';

/** @type {Record<string, (format: string | undefined) => string | undefined>} */
const tokens = {};

/**
 * @param {string} name
 * @param {(format: string | undefined) => string | undefined} fn
 */
function token(name, fn) {
  tokens[name] = fn;
}

token('date', function getDateToken(format) {
  var date = new Date(86400000 * 400);
  switch (format || 'iso') {
    case 'clf':
      return clfdate(date);
    case 'iso':
      return date.toISOString();
  }
});

/**
 * @param {Date} dateTime
 * @return {string}
 */
function clfdate(dateTime) {
  return dateTime.getUTCDate() + '/' + dateTime.getUTCMonth() + '/' + dateTime.getUTCFullYear();
}

const date = tokens['date'];
if (date) console.log(date('clf'), date('iso'), date(undefined), date('other'));
