#!/usr/bin/env node
// Regenerates luci-app-tailscale-vnode/po/templates/tailscale-vnode.pot from
// the LuCI sources and rewrites every po/<lang>/tailscale-vnode.po against it,
// keeping existing translations and dropping strings that no longer exist.
//
//   node tools/update-po.js [extra.json]
//
// extra.json maps language -> { msgid: msgstr } for new strings.

'use strict';

const fs = require('fs');
const path = require('path');

const app = path.join(__dirname, '..', 'luci-app-tailscale-vnode');
// Every JavaScript file of the app.
const sources = fs.readdirSync(path.join(app, 'htdocs'), { recursive: true })
	.filter((f) => f.endsWith('.js')).sort().map((f) => path.join(app, 'htdocs', f));
const menus = [ path.join(app, 'root/usr/share/luci/menu.d/luci-app-tailscale-vnode.json') ];

function extract() {
	const ids = new Set();
	// _('...') with optional '...' + '...' concatenation across lines.
	const call = /_\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)\)/g;
	for (const file of sources) {
		const src = fs.readFileSync(file, 'utf8');
		for (const m of src.matchAll(call))
			ids.add([ ...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g) ].map((p) => p[1].replace(/\\(.)/g, '$1')).join(''));
	}
	for (const file of menus)
		for (const entry of Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))))
			if (entry.title)
				ids.add(entry.title);
	return [ ...ids ].sort();
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unesc = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

function parsePo(text) {
	const map = {};
	for (const m of text.matchAll(/^msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"$/gm))
		if (m[1])
			map[unesc(m[1])] = unesc(m[2]);
	return map;
}

const ids = extract();
const extra = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {};

let pot = 'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8"\n';
for (const id of ids)
	pot += `\nmsgid "${esc(id)}"\nmsgstr ""\n`;
fs.writeFileSync(path.join(app, 'po/templates/tailscale-vnode.pot'), pot);
console.log(`template: ${ids.length} strings`);

for (const lang of fs.readdirSync(path.join(app, 'po'))) {
	if (lang === 'templates')
		continue;
	const file = path.join(app, 'po', lang, 'tailscale-vnode.po');
	const old = fs.existsSync(file) ? parsePo(fs.readFileSync(file, 'utf8')) : {};
	const add = extra[lang] || {};
	const missing = [];

	let po = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n' +
		`"Language: ${lang}\\n"\n"Plural-Forms: nplurals=1; plural=0;\\n"\n`;
	for (const id of ids) {
		const str = add[id] || old[id] || '';
		if (!str)
			missing.push(id);
		po += `\nmsgid "${esc(id)}"\nmsgstr "${esc(str)}"\n`;
	}
	fs.writeFileSync(file, po);
	const dropped = Object.keys(old).filter((id) => !ids.includes(id));
	console.log(`${lang}: ${ids.length - missing.length}/${ids.length} translated, ${dropped.length} dropped`);
	for (const id of missing)
		console.log(`  missing: ${JSON.stringify(id)}`);
}
