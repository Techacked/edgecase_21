"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashObject = exports.sha256Hex = exports.stableStringify = void 0;
const node_crypto_1 = require("node:crypto");
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const obj = value;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
exports.stableStringify = stableStringify;
const sha256Hex = (s) => (0, node_crypto_1.createHash)('sha256').update(s).digest('hex');
exports.sha256Hex = sha256Hex;
const hashObject = (v) => (0, exports.sha256Hex)(stableStringify(v));
exports.hashObject = hashObject;
