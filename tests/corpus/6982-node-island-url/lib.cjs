"use strict";
const util = require("node:util");
const { fileURLToPath, urlToHttpOptions } = require("node:url");

let last;
const weak = new WeakMap();

exports.describe = (u) => {
  const href = Object.getOwnPropertyDescriptor(URL.prototype, "href").get;
  let clone;
  try {
    clone = String(structuredClone(u));
  } catch (error) {
    clone = error.name;
  }
  return [
    `tag ${Object.prototype.toString.call(u)} ${typeof u}`,
    `instanceof ${u instanceof URL} ${Object.getPrototypeOf(u) === URL.prototype} ${u.constructor === URL}`,
    `own ${Reflect.ownKeys(u).length} ${Object.keys(u).length} ${Object.isExtensible(u)}`,
    `brand ${href.call(u)} ${URL.prototype.toJSON.call(u)}`,
    `parts ${u.protocol} ${u.username} ${u.password} ${u.host} ${u.hostname} ${u.port} ${u.pathname} ${u.search} ${u.hash} ${u.origin}`,
    `text ${u} ${JSON.stringify(u)} ${JSON.stringify({ u })}`,
    `inspect ${util.inspect(u, { breakLength: Infinity })}`,
    `params ${u.searchParams.get("x")} ${u.searchParams.get("y")} ${u.searchParams.size} ${u.searchParams === u.searchParams}`,
    `clone ${clone}`,
    `equal ${util.isDeepStrictEqual(u, new URL(u.href))}`,
    `resolve ${new URL("../up?z=3", u).href}`,
  ];
};

// What a proxy agent does with the URL it is constructed with.
exports.Agent = class Agent {
  constructor(proxy) {
    this.proxy = typeof proxy === "string" ? new URL(proxy) : proxy;
    this.secure = this.proxy.protocol === "https:";
    const host = (this.proxy.hostname || this.proxy.host).replace(/^\[|\]$/g, "");
    const port = this.proxy.port ? parseInt(this.proxy.port, 10) : this.secure ? 443 : 80;
    this.connect = { host, port };
    this.auth =
      this.proxy.username || this.proxy.password
        ? Buffer.from(
            `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`,
          ).toString("base64")
        : null;
  }
  describe() {
    return `${this.proxy instanceof URL} ${this.secure} ${this.connect.host}:${this.connect.port} ${this.auth} ${this.proxy.href}`;
  }
};
exports.agentUrlIs = (agent, url) => agent.proxy === url;

exports.httpOptions = (u) => {
  const o = urlToHttpOptions(u);
  return `${o.protocol} ${o.hostname} ${o.port} ${o.path} ${o.auth}`;
};
exports.filePath = (u) => fileURLToPath(u);
exports.requestUrl = (u) => new Request(u).url;

exports.keep = (u) => {
  const same = last === u;
  last = u;
  return same;
};
exports.kept = () => last;
exports.remember = (u, label) => {
  const before = weak.get(u);
  weak.set(u, label);
  return String(before);
};
exports.sameMember = (record, key, u) => record[key] === u;
exports.hrefOf = (target) => `${target.label} ${target.url.href}`;
exports.back = (u) => u;
exports.wrap = (u) => ({ url: u });
exports.href = (u) => `${Object.prototype.toString.call(u)} ${u.href}`;
