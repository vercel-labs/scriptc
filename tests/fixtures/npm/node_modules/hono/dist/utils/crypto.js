//#region src/utils/crypto.ts
const sha256 = async (data) => {
	return await createHash(data, {
		name: "SHA-256",
		alias: "sha256"
	});
};
const sha1 = async (data) => {
	return await createHash(data, {
		name: "SHA-1",
		alias: "sha1"
	});
};
const md5 = async (data) => {
	return await createHash(data, {
		name: "MD5",
		alias: "md5"
	});
};
const createHash = async (data, algorithm) => {
	let sourceBuffer;
	if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) sourceBuffer = data;
	else {
		if (typeof data === "object") data = JSON.stringify(data);
		sourceBuffer = new TextEncoder().encode(String(data));
	}
	if (crypto && crypto.subtle) {
		const buffer = await crypto.subtle.digest({ name: algorithm.name }, sourceBuffer);
		return Array.prototype.map.call(new Uint8Array(buffer), (x) => ("00" + x.toString(16)).slice(-2)).join("");
	}
	return null;
};
//#endregion
export { createHash, md5, sha1, sha256 };
