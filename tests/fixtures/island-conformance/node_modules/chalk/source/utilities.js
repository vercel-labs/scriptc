// Note: Each match is kept and `postfix` is inserted after it. `String#replaceAll(substring, substring + postfix)` does the same, but it has to scan the replacement for `$` patterns and it is several times slower on the no-match path that most calls take.
export function stringReplaceAll(string, substring, postfix) {
	let index = string.indexOf(substring);
	if (index === -1) {
		return string;
	}

	const substringLength = substring.length;
	let endIndex = 0;
	let returnValue = '';
	do {
		returnValue += string.slice(endIndex, index) + substring + postfix;
		endIndex = index + substringLength;
		index = string.indexOf(substring, endIndex);
	} while (index !== -1);

	returnValue += string.slice(endIndex);
	return returnValue;
}

export function stringEncaseCRLFWithFirstIndex(string, prefix, postfix, index) {
	let endIndex = 0;
	let returnValue = '';
	do {
		const isGotCR = string[index - 1] === '\r';
		returnValue += string.slice(endIndex, (isGotCR ? index - 1 : index)) + prefix + (isGotCR ? '\r\n' : '\n') + postfix;
		endIndex = index + 1;
		index = string.indexOf('\n', endIndex);
	} while (index !== -1);

	returnValue += string.slice(endIndex);
	return returnValue;
}
