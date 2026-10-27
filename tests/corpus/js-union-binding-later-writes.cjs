// A JavaScript binding the checker types as a union from its initializer
// (`re.exec(text)` is an array or null) and later assigns a value that
// fits none of the union's arms holds the new value, as Node does.
var matchHtml = /["&<>]/;

function escape(text) {
  var match = matchHtml.exec(text);
  if (match) {
    var html = "",
      index,
      last = 0;
    for (index = match.index; index < text.length; index++) {
      switch (text.charCodeAt(index)) {
        case 34:
          match = "&quot;";
          break;
        case 38:
          match = "&amp;";
          break;
        case 60:
          match = "&lt;";
          break;
        case 62:
          match = "&gt;";
          break;
        default:
          continue;
      }
      last !== index && (html += text.slice(last, index));
      last = index + 1;
      html += match;
    }
    text = last !== index ? html + text.slice(last, index) : html;
  }
  return text;
}

function firstWord(text) {
  let found = /\w+/.exec(text);
  if (found === null) found = 0;
  return found;
}

let state = [1, 2].find((n) => n > 5) ?? null;
state = "ready";

// Writes that fit an arm keep the union.
function lastMatch(texts) {
  let m = null;
  for (const t of texts) m = /\d+/.exec(t) || m;
  return m === null ? "none" : m[0];
}

console.log(escape('a<b & "c">'), escape("plain"));
const word = firstWord("hello world");
console.log(word[0], word.index, firstWord("..."));
console.log(state, typeof state);
console.log(lastMatch(["a1", "b", "c22"]), lastMatch(["x"]));
