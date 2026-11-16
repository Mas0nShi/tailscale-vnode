#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
//
// Compiles a .po file into LuCI's .lmo format, like po2lmo from luci-base,
// for deploying translations without the SDK (tools/deploy.sh).
//
//   node tools/po2lmo.js input.po output.lmo
//
// Format (all integers big-endian uint32): the translated strings, each
// padded with NULs to a multiple of 4 bytes; then an index of 16-byte
// entries {key hash, plural count, offset, length} sorted by key hash; then
// the offset of the index. Keys are hashed with sfh_hash (lib/lmo.c).
// Context and plural forms are supported the same way as in po2lmo.

'use strict';

const fs = require('fs');

function sfh(buf) {
	let len = buf.length, hash = len >>> 0, off = 0, tmp;
	if (len <= 0)
		return 0;

	const g16 = (o) => buf[o] | (buf[o + 1] << 8);
	const sc = (b) => (b << 24) >> 24; // (signed char)
	const rem = len & 3;

	for (let n = len >>> 2; n > 0; n--) {
		hash = (hash + g16(off)) >>> 0;
		tmp = ((g16(off + 2) << 11) ^ hash) >>> 0;
		hash = ((hash << 16) ^ tmp) >>> 0;
		off += 4;
		hash = (hash + (hash >>> 11)) >>> 0;
	}

	switch (rem) {
	case 3:
		hash = (hash + g16(off)) >>> 0;
		hash = (hash ^ (hash << 16)) >>> 0;
		hash = (hash ^ (sc(buf[off + 2]) << 18)) >>> 0;
		hash = (hash + (hash >>> 11)) >>> 0;
		break;
	case 2:
		hash = (hash + g16(off)) >>> 0;
		hash = (hash ^ (hash << 11)) >>> 0;
		hash = (hash + (hash >>> 17)) >>> 0;
		break;
	case 1:
		hash = (hash + sc(buf[off])) >>> 0;
		hash = (hash ^ (hash << 10)) >>> 0;
		hash = (hash + (hash >>> 1)) >>> 0;
	}

	hash = (hash ^ (hash << 3)) >>> 0;
	hash = (hash + (hash >>> 5)) >>> 0;
	hash = (hash ^ (hash << 4)) >>> 0;
	hash = (hash + (hash >>> 17)) >>> 0;
	hash = (hash ^ (hash << 25)) >>> 0;
	hash = (hash + (hash >>> 6)) >>> 0;
	return hash;
}

// The contents of a quoted .po string as po2lmo reads it: \" and \\ lose
// their backslash, other escapes are kept as written.
function unquote(line) {
	const m = /"(.*)"\s*$/.exec(line);
	return m ? m[1].replace(/\\(["\\])/g, '$1') : '';
}

function parse(text) {
	const msgs = [];
	let msg = null, cur = null;

	const flush = () => {
		if (msg)
			msgs.push(msg);
		msg = null;
		cur = null;
	};

	for (const line of text.split('\n')) {
		let m;
		if (/^\s*(#|$)/.test(line)) {
			continue;
		}
		else if (line.startsWith('msgctxt ')) {
			flush();
			msg = { val: [] };
			msg.ctxt = unquote(line);
			cur = 'ctxt';
		}
		else if (line.startsWith('msgid ')) {
			if (!msg || msg.id !== undefined)
				flush(), msg = { val: [] };
			msg.id = unquote(line);
			cur = 'id';
		}
		else if (line.startsWith('msgid_plural ')) {
			msg.plural = unquote(line);
			cur = 'plural';
		}
		else if ((m = /^msgstr(?:\[(\d+)\])?\s/.exec(line))) {
			const i = m[1] ? +m[1] : 0;
			msg.val[i] = unquote(line);
			cur = i;
		}
		else if (/^\s*"/.test(line) && msg && cur !== null) {
			const s = unquote(line);
			if (typeof cur === 'number')
				msg.val[cur] += s;
			else
				msg[cur] += s;
		}
	}
	flush();
	return msgs;
}

function compile(msgs) {
	const chunks = [], index = [];
	let offset = 0;

	const add = (keyId, valId, str) => {
		const data = Buffer.from(str, 'utf8');
		const pad = (4 - (data.length % 4)) % 4;
		index.push([ keyId, valId, offset, data.length ]);
		chunks.push(data, Buffer.alloc(pad));
		offset += data.length + pad;
	};

	for (const msg of msgs) {
		if (msg.id === '') {
			// Header: only Plural-Forms is kept, under key 0.
			const pf = (msg.val[0] || '').split('\\n').find((f) => /^Plural-Forms: /i.test(f));
			if (pf)
				add(0, 0, pf.slice(14));
			continue;
		}

		msg.val.forEach((val, i) => {
			if (!val)
				return;

			let key;
			if (msg.ctxt !== undefined && msg.plural !== undefined)
				key = msg.ctxt + '\x01' + msg.id + '\x02' + i;
			else if (msg.ctxt !== undefined)
				key = msg.ctxt + '\x01' + msg.id;
			else if (msg.plural !== undefined)
				key = msg.id + '\x02' + i;
			else
				key = msg.id;

			const keyId = sfh(Buffer.from(key, 'utf8'));
			// Untranslated entries (same text) are left out.
			if (keyId !== sfh(Buffer.from(val, 'utf8')))
				add(keyId, msg.val.length, val);
		});
	}

	if (!offset)
		return null;

	index.sort((a, b) => a[0] - b[0]);
	const idx = Buffer.alloc(index.length * 16 + 4);
	index.forEach((e, n) => e.forEach((v, j) => idx.writeUInt32BE(v, n * 16 + j * 4)));
	idx.writeUInt32BE(offset, index.length * 16);
	return Buffer.concat(chunks.concat(idx));
}

// Looks up msgid `key` in a compiled .lmo, for checking this tool against
// files built by po2lmo.
function lookup(lmo, key) {
	const idxOff = lmo.readUInt32BE(lmo.length - 4);
	const want = sfh(Buffer.from(key, 'utf8'));
	for (let p = idxOff; p + 16 <= lmo.length - 4; p += 16) {
		if (lmo.readUInt32BE(p) === want) {
			const off = lmo.readUInt32BE(p + 8), len = lmo.readUInt32BE(p + 12);
			return lmo.slice(off, off + len).toString('utf8');
		}
	}
	return null;
}

if (require.main === module) {
	const [ cmd, a, b ] = process.argv.slice(2);
	if (cmd === '--lookup') {
		console.log(lookup(fs.readFileSync(a), b));
	}
	else if (cmd && a) {
		const out = compile(parse(fs.readFileSync(cmd, 'utf8')));
		if (!out) {
			console.error('no translations in ' + cmd);
			process.exit(1);
		}
		fs.writeFileSync(a, out);
	}
	else {
		console.error('usage: po2lmo.js input.po output.lmo | --lookup file.lmo msgid');
		process.exit(1);
	}
}

module.exports = { sfh, parse, compile, lookup };
