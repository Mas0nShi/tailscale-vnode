'use strict';
'require baseclass';

// SPDX-License-Identifier: GPL-2.0-only
//
// The connection view of the tailscale-vnode page: who is connected to
// which node of this router, directly or through which DERP relay.

const RE_MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

// A host name without the local domain (DESKTOP-1.lan -> DESKTOP-1).
const shortName = (name) => (name || '').split('.')[0];

// Laid out as a network path: visitor cards on the left, DERP relays in the
// middle, this router's nodes on the right, curved links between them. Own
// styles only, in currentColor and translucent greys, so that it does not
// depend on any theme.
const CSS = `
.tsv-path { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(48px, 110px) minmax(0, .8fr) minmax(48px, 110px) minmax(0, 1fr); align-items: center; padding: 1em 0; }
.tsv-path::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at 1px 1px, rgba(128, 128, 128, .3) 1px, transparent 1.4px) 0 0 / 18px 18px; -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, .55), transparent 85%); mask-image: linear-gradient(180deg, rgba(0, 0, 0, .55), transparent 85%); }
.tsv-wrap { position: relative; }
.tsv-wrap canvas.tsv-backdrop { position: absolute; left: 0; top: 0; pointer-events: none; }
.tsv-path > * { position: relative; }
.tsv-path.tsv-has-local { padding-right: 44px; }
.tsv-path .tsv-derp { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: .25em .75em; margin-bottom: 1.25em; font-size: 90%; }
.tsv-path .tsv-derp .tsv-cap { margin-right: .25em; }
.tsv-path .tsv-left, .tsv-path .tsv-mid, .tsv-path .tsv-right { display: flex; flex-direction: column; gap: .75em; min-width: 0; position: relative; z-index: 1; }
.tsv-path .tsv-left { grid-column: 1; }
.tsv-path .tsv-mid { grid-column: 3; }
.tsv-path .tsv-right { grid-column: 5; }
.tsv-path .tsv-card { display: flex; gap: .6em; align-items: flex-start; background: var(--tsv-bg, transparent); padding: .6em .8em; border: 1px solid var(--tsv-line, rgba(128, 128, 128, .35)); border-radius: 8px; box-shadow: 0 1px 2px rgba(0, 0, 0, .05); min-width: 0; }
.tsv-path .tsv-ico { flex: none; width: 20px; height: 20px; margin-top: .1em; opacity: .75; }
.tsv-path .tsv-ico svg { display: block; width: 100%; height: 100%; }
.tsv-path .tsv-body { flex: 1; min-width: 0; }
.tsv-path .tsv-mark { opacity: 1; }
.tsv-path .tsv-card.tsv-off > :not(.tsv-mark) { opacity: .55; }
.tsv-path .tsv-cap { display: block; font-size: 72%; letter-spacing: .08em; text-transform: uppercase; opacity: .65; }
.tsv-path .tsv-title { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsv-path .tsv-sub { display: block; font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 85%; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsv-path .tsv-none { opacity: .55; font-style: italic; }
.tsv-path svg.tsv-lines { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.tsv-path svg.tsv-lines path { fill: none; }
.tsv-path svg.tsv-lines .tsv-wire { stroke: var(--tsv-line, rgba(128, 128, 128, .45)); stroke: color-mix(in srgb, var(--tsv-accent, currentColor) 40%, var(--tsv-line, rgba(128, 128, 128, .45))); stroke-width: 1.5; transition: stroke .2s, stroke-width .2s; }
.tsv-path svg.tsv-lines .tsv-flow { stroke: var(--tsv-accent, currentColor); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 1.5 30; }
.tsv-path svg.tsv-lines g, .tsv-path .tsv-card { transition: opacity .2s; }
.tsv-path.tsv-hover svg.tsv-lines g:not(.tsv-hl) { opacity: .2; }
.tsv-path.tsv-hover .tsv-card:not(.tsv-hl) { opacity: .5; }
.tsv-path svg.tsv-lines g.tsv-hl .tsv-wire { stroke: var(--tsv-accent, currentColor); stroke-width: 2; }
.tsv-path .tsv-card.tsv-hl { border-color: var(--tsv-accent, currentColor); }

.tsv-path .tsv-mobile { display: none; }
@media (max-width: 640px) {
	.tsv-path { grid-template-columns: minmax(0, 1fr); }
	.tsv-path .tsv-left, .tsv-path .tsv-mid, .tsv-path .tsv-right { grid-column: 1; }
	.tsv-path .tsv-mid, .tsv-path .tsv-right { margin-top: .75em; }
	.tsv-path svg.tsv-lines { display: none; }
	.tsv-path .tsv-mobile { display: block; }
}`;

// Animated backdrop of the connection view, after the "grid" backdrop of the
// Vantage theme's dashboard: packets travel along the lines of the 18 px
// dot grid, mostly left to right, now and then stepping to another row,
// each a thin trail fading over five shades behind a small square head.
// Drawn on a canvas at about 20 frames a second, in the theme's accent
// colour where it defines one (else the link colour); paused while the
// page is hidden, a single still frame under reduced motion.
function packetBackdrop(host) {
	const GRID = 18, DOT = 1, SHADES = 5, ALPHA = [ .6, .36, .2, .1, .04 ];
	const DIRS = [ [ 1, 0 ], [ 0, 1 ], [ -1, 0 ], [ 0, -1 ] ];
	const cv = E('canvas', { 'class': 'tsv-backdrop', 'aria-hidden': 'true' });
	const ctx = cv.getContext && cv.getContext('2d');
	if (!ctx || typeof Path2D !== 'function')
		return { fit() {}, load() {} };
	host.insertBefore(cv, host.firstChild);

	const env = { w: 0, h: 0, count: 2, speed: 45, share: .7, colour: '#7a9a3a' };
	const list = [];
	const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
	const line = (v) => DOT + GRID * v;
	const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	let level = 0, last = 0, dpr = 1;

	function spawn(p, anywhere) {
		const r0 = Math.ceil((4 - DOT) / GRID), r1 = Math.max(r0, Math.floor((env.h - 4 - DOT) / GRID));
		const c1 = Math.floor((env.w - DOT) / GRID);
		p.main = p.d = Math.random() < env.share ? 0 : 2;
		const col = anywhere ? Math.floor(Math.random() * (c1 + 1)) : (p.main === 0 ? -2 : c1 + 2);
		p.x = line(col);
		p.y = line(r0 + Math.floor(Math.random() * (r1 - r0 + 1)));
		p.pts = [ [ p.x, p.y ] ];
		p.v = env.speed * (.7 + Math.random() * .6);
		p.len = clamp(p.v * .45, 28, 120);
		p.next = GRID;
		return p;
	}

	// Drops the corners the tail has passed; returns the tail's end.
	function trim(p) {
		let left = p.len, hx = p.x, hy = p.y;
		for (let k = p.pts.length - 1; k >= 0; k--) {
			const q = p.pts[k], seg = Math.abs(hx - q[0]) + Math.abs(hy - q[1]);
			if (seg >= left) {
				if (k > 0)
					p.pts.splice(0, k);
				return [ hx + (q[0] - hx) * left / (seg || 1), hy + (q[1] - hy) * left / (seg || 1) ];
			}
			left -= seg;
			hx = q[0];
			hy = q[1];
		}
		return [ hx, hy ];
	}

	// At a grid point: a packet on its row sometimes steps up or down, one
	// on a column usually turns back onto a row.
	function turn(p) {
		if (p.d === 0 || p.d === 2) {
			if (Math.random() < .16) {
				let d = Math.random() < .5 ? 1 : 3;
				const ny = p.y + DIRS[d][1] * GRID;
				if (ny < 4 || ny > env.h - 4)
					d = 4 - d;
				p.pts.push([ p.x, p.y ]);
				p.d = d;
			}
		}
		else {
			const ny = p.y + DIRS[p.d][1] * GRID;
			if (Math.random() < .55 || ny < 4 || ny > env.h - 4) {
				p.pts.push([ p.x, p.y ]);
				p.d = p.main;
			}
		}
	}

	function step(dt) {
		const m = 3 * GRID;
		for (const p of list) {
			let go = p.v * dt;
			while (go > 0) {
				const s = Math.min(go, p.next);
				p.x += DIRS[p.d][0] * s;
				p.y += DIRS[p.d][1] * s;
				p.next -= s;
				go -= s;
				if (p.next <= 0) {
					p.next = GRID;
					turn(p);
				}
			}
			const tail = trim(p);
			if (((p.x < -m || p.x > env.w + m) && (tail[0] < -m || tail[0] > env.w + m)) || p.y < -GRID || p.y > env.h + GRID)
				spawn(p, false);
		}
	}

	function draw() {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, env.w, env.h);
		const shade = [], heads = new Path2D(), glow = new Path2D();
		for (let k = 0; k < SHADES; k++)
			shade.push(new Path2D());

		for (const p of list) {
			let hx = p.x, hy = p.y, run = 0, n = 0;
			const piece = p.len / SHADES;
			for (let j = p.pts.length - 1; j >= 0 && n < SHADES; j--) {
				const q = p.pts[j], seg = Math.abs(hx - q[0]) + Math.abs(hy - q[1]);
				let at = 0;
				while (at < seg && n < SHADES) {
					const take = Math.min(seg - at, piece * (n + 1) - run), t0 = at / (seg || 1), t1 = (at + take) / (seg || 1);
					shade[n].moveTo(hx + (q[0] - hx) * t0, hy + (q[1] - hy) * t0);
					shade[n].lineTo(hx + (q[0] - hx) * t1, hy + (q[1] - hy) * t1);
					at += take;
					run += take;
					if (run >= piece * (n + 1) - .01)
						n++;
				}
				hx = q[0];
				hy = q[1];
			}
			heads.rect(p.x - 1.25, p.y - 1.25, 2.5, 2.5);
			glow.rect(p.x - 3.5, p.y - 3.5, 7, 7);
		}

		ctx.strokeStyle = ctx.fillStyle = env.colour;
		ctx.lineWidth = 1.25;
		for (let s = 0; s < SHADES; s++) {
			ctx.globalAlpha = ALPHA[s];
			ctx.stroke(shade[s]);
		}
		ctx.globalAlpha = .12;
		ctx.fill(glow);
		ctx.globalAlpha = .8;
		ctx.fill(heads);
		ctx.globalAlpha = 1;
	}

	// The accent colour, and the opaque colour behind the view for cards.
	function colours() {
		const root = getComputedStyle(document.documentElement);
		let c = (root.getPropertyValue('--accent-line') || root.getPropertyValue('--primary') || '').trim();
		if (!c) {
			const a = host.appendChild(E('a', { 'href': '#' }));
			c = getComputedStyle(a).color;
			a.remove();
		}
		env.colour = c || env.colour;
		host.style.setProperty('--tsv-accent', env.colour);
		// The border colour the theme gives its sections, for cards and idle lines.
		const sec = host.closest('.cbi-section'), cs = sec && getComputedStyle(sec);
		if (cs && parseFloat(cs.borderTopWidth) > 0)
			host.style.setProperty('--tsv-line', cs.borderTopColor);

		for (let el = host; el; el = el.parentElement) {
			const bg = getComputedStyle(el).backgroundColor;
			if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) {
				host.style.setProperty('--tsv-bg', bg);
				break;
			}
		}
	}

	function fit() {
		const w = host.clientWidth, h = host.clientHeight;
		if (w < 40 || h < 40)
			return;
		const first = !env.w;
		dpr = Math.min(window.devicePixelRatio || 1, 1.5);
		if (w !== env.w || h !== env.h) {
			env.w = w;
			env.h = h;
			cv.width = Math.round(w * dpr);
			cv.height = Math.round(h * dpr);
			cv.style.width = w + 'px';
			cv.style.height = h + 'px';
		}
		colours();
		// As many packets as the area and the activity call for.
		const top = clamp(Math.round(w * h / 14000), 6, 36);
		env.count = Math.round(2 + (top - 2) * level);
		env.speed = 45 + 175 * level;
		list.length = Math.min(list.length, env.count);
		while (list.length < env.count)
			list.push(spawn({}, first));
		if (first)
			for (let i = 0; i < 12; i++)
				step(.05);
		if (still)
			draw();
	}

	let attached = false;
	function frame(t) {
		if (cv.isConnected)
			attached = true;
		else if (attached)
			return;
		if (attached && !env.w)
			fit();
		if (!document.hidden && env.w && t - last >= 50) {
			step(Math.min((t - last) / 1000, .1));
			last = t;
			draw();
		}
		window.requestAnimationFrame(frame);
	}
	if (!still)
		window.requestAnimationFrame(frame);

	return {
		fit,
		// Activity from 0 to 1: more and faster packets.
		load(v) { level = clamp(v, 0, 1); }
	};
}

// Device-type line icons, drawn in the text colour.
const icon = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
const ICONS = {
	laptop: icon('<rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 19h20"/>'),
	desktop: icon('<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M9 20h6M12 16v4"/>'),
	phone: icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'),
	server: icon('<rect x="4" y="4" width="16" height="7" rx="1"/><rect x="4" y="13" width="16" height="7" rx="1"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
	router: icon('<rect x="3" y="13" width="18" height="6" rx="1"/><path d="M7 16h.01M10 16h.01M8 13 6 7M16 13l2-6"/>'),
	warn: icon('<path d="M10.3 4.6 3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.5M12 17h.01"/>'),
	off: icon('<path d="M12 4v8"/><path d="M7.5 6.8a7 7 0 1 0 9 0"/>'),
	host: icon('<rect x="6" y="3.5" width="12" height="17" rx="1.5"/><path d="M9.5 7.5h5M9.5 10.5h5M12 16.5h.01"/>'),
	relay: icon('<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6M12 3v6M12 15v6"/>')
};

// The icon for a Tailscale client, by the OS it reports to the tailnet:
// phones, personal computers, and servers for everything else.
function clientIcon(os) {
	if (/^(ios|android)$/i.test(os || ''))
		return ICONS.phone;
	if (/^(macos|windows)$/i.test(os || ''))
		return ICONS.laptop;
	return ICONS.server;
}

// The icon for a LAN device, the way the Vantage theme picks one for its
// client list: the icon set for it there (by MAC), else a guess from its
// name. Kinds without an icon of their own here get the generic one.
const KIND_ICON = { phone: 'phone', tablet: 'phone', watch: 'phone', laptop: 'laptop', desktop: 'desktop', router: 'router' };
const GUESS = [
	[ /\b(print|printer|envy|officejet|deskjet|laserjet|pixma|ecotank|mfc-|hl-|brother|epson|canon)/i, 'printer' ],
	[ /\b(iphone|pixel|galaxy|android|phone|redmi|oneplus|xperia|moto)/i, 'phone' ],
	[ /\b(ipad|tablet|tab\b|kindle|fire hd)/i, 'tablet' ],
	[ /\b(macbook|laptop|notebook|thinkpad|surface|chromebook|xps|zenbook|ideapad)/i, 'laptop' ],
	[ /\b(imac|desktop|workstation|\bpc\b|mac mini|nuc)/i, 'desktop' ],
	[ /\b(tv|bravia|roku|chromecast|fire ?tv|shield|apple ?tv|webos|tizen)/i, 'tv' ],
	[ /\b(echo|sonos|homepod|speaker|nest mini|google home)/i, 'speaker' ],
	[ /\b(cam|camera|doorbell|ring|arlo|wyze|eufy)/i, 'camera' ],
	[ /\b(playstation|ps[345]|xbox|nintendo|switch|steam ?deck)/i, 'console' ],
	[ /\b(watch)/i, 'watch' ],
	[ /\b(esp[-_]?\d|shelly|tasmota|sonoff|tuya|hue|plug|bulb|thermostat|sensor)/i, 'iot' ],
	[ /\b(router|access point|\bap\b|openwrt|fritz|repeater|mesh)/i, 'router' ]
];

function deviceIcon(kind, name) {
	if (!kind) {
		const rule = GUESS.find(([ re ]) => re.test(name || ''));
		kind = rule ? rule[1] : '';
	}
	return ICONS[KIND_ICON[kind]] || ICONS.host;
}
// A card: device icon, then an optional small caption, the title and
// monospace detail lines. card.body takes further lines.
function pathCard(iconSvg, caption, title, lines, cls) {
	const ico = E('span', { 'class': 'tsv-ico' });
	ico.innerHTML = iconSvg;
	const body = E('div', { 'class': 'tsv-body' }, [
		caption ? E('span', { 'class': 'tsv-cap' }, caption) : '',
		E('span', { 'class': 'tsv-title' }, title)
	].concat(lines.filter((l) => l).map((l) => E('span', { 'class': 'tsv-sub' }, l))));
	const card = E('div', { 'class': 'tsv-card' + (cls ? ' ' + cls : '') }, [ ico, body ]);
	card.body = body;
	return card;
}

// Marks a card whose node is not running: an icon at its right, the state
// as its tooltip (stopped or disabled: power; anything else: warning).
function markState(card, node) {
	if (node.state === 'Running')
		return card;
	const mark = E('span', { 'class': 'tsv-ico tsv-mark', 'title': stateBadge(node).textContent });
	mark.innerHTML = (!node.enabled || node.state === 'stopped') ? ICONS.off : ICONS.warn;
	card.appendChild(mark);
	card.classList.add('tsv-off');
	return card;
}

function stateBadge(node) {
	if (!node.enabled)
		return E('span', { 'class': 'label' }, _('Disabled'));

	switch (node.state) {
	case 'Running':
		return E('span', { 'class': 'label success' }, _('Running'));
	case 'NeedsLogin':
		return E('span', { 'class': 'label warning' }, _('Needs login'));
	case 'stopped':
		return E('span', { 'class': 'label' }, _('Stopped'));
	default:
		return E('span', { 'class': 'label' }, node.state || '-');
	}
}

const Topology = baseclass.extend({
	// `view` is the page: it holds the host hints (hosts, kinds), the
	// Cloudflare DNS settings (dns) and the node status (nodes).
	__init__(view) {
		this.view = view;
		this.el = E('div', { 'class': 'tsv-wrap' }, [ E('style', {}, CSS), E('div', { 'class': 'tsv-path' }) ]);
		this.backdrop = packetBackdrop(this.el);
		// The links need the laid-out cards: drawn once the view is in the
		// document, and again whenever the width changes.
		const redraw = () => window.requestAnimationFrame(() => this.draw());
		const boot = window.setInterval(() => {
			if (this.el.isConnected) {
				window.clearInterval(boot);
				redraw();
			}
		}, 50);
		window.addEventListener('resize', redraw);
	},

	// Shows the topology reported by the tailscale-vnode ubus object.
	update(topo) {
		this.el.querySelector('.tsv-path').replaceWith(this.render(topo || {}));
		this.backdrop.load(Math.min(.5, this.routes.length * .06));
		window.requestAnimationFrame(() => this.draw());
	},

	// Visitors on the left, DERP relays in the middle, this router's nodes on
	// the right. Every connection is a route of its own, visitor -> node,
	// passing through the DERP region that relays it if it is not direct.
	// The routes are drawn by draw() once the cards are laid out.
	render(topo) {
		const regions = {};
		for (const r of ((topo.derp || {}).regions || []))
			regions[r.code] = r;

		// A DERP card stands for a region relaying a connection shown here.
		const visitorCards = {}, derpCards = {}, routes = [];
		const derpCard = (code) => {
			if (!derpCards[code]) {
				const r = regions[code] || { code: code, name: code };
				derpCards[code] = pathCard(ICONS.relay, 'DERP', r.name || r.code,
					[ r.latency != null ? '%d ms'.format(r.latency) : _('unreachable') ], 'tsv-derp-node');
			}
			return derpCards[code];
		};

		// Every Tailscale node on this router is drawn the same way: its own
		// node first, then the virtual ones, those with visitors first so
		// linked cards sit together. Traffic between these nodes is local
		// and not a visitor.
		const local = new Set((topo.nodes || []).map((n) => n.ip).filter((ip) => ip));
		const ordered = (topo.nodes || []).slice().sort((a, b) =>
			((b.kind === 'host') - (a.kind === 'host')) ||
			((b.visitors || []).length > 0) - ((a.visitors || []).length > 0));

		const cardOf = {};
		const right = ordered.map((n) => {
			let card;
			if (n.kind === 'host') {
				card = pathCard(ICONS.router, '', n.hostname, [ n.ip ]);
			}
			else {
				const ip = n.target_ip;
				const mac = RE_MAC.test(n.target || '') ? n.target.toUpperCase()
					: this.view.macOf(ip);
				const host = mac ? shortName((this.view.hosts[mac] || {}).name) : '';
				const hostState = (n.target_state === 'offline') ? _('Host does not respond') : _('Host has no address');
				const status = (this.view.nodes || []).find((x) => x.name === n.name) || {};
				const dnsName = (this.view.dns.enabled && status.record_state === 'ok') ? status.record
					: (status.magic_dns ? (status.dns_name || '').replace(/\.$/, '') : '');

				// The icon is the one chosen for the node, else the one for
				// the host behind it.
				card = pathCard(ICONS[n.icon] || deviceIcon(this.view.kinds[mac], host), '', n.hostname || n.name, [
					n.ip, dnsName,
					host ? '%s %s'.format(host, ip || '') : (ip || n.target)
				]);
				// A host that does not answer is marked like a node that is
				// not running; an answering one needs no remark.
				if (n.state === 'Running' && n.target_state !== 'online') {
					const mark = E('span', { 'class': 'tsv-ico tsv-mark', 'title': hostState });
					mark.innerHTML = ICONS.warn;
					card.appendChild(mark);
				}
			}
			markState(card, n);
			if (n.ip)
				cardOf[n.ip] = card;
			return card;
		});

		for (const n of ordered) {
			const card = cardOf[n.ip];
			for (const v of (n.visitors || [])) {
				// A connection from another node on this router: a local
				// route between two cards of the right column.
				// So is one from a LAN host that the router carried into the
				// tailnet, when a node stands for that host. A LAN host
				// without a node of its own (a phone on the Wi-Fi, say) is
				// drawn as a visitor of its own.
				let source = null;
				if (v.lan) {
					const owner = ordered.find((x) => x.kind !== 'host' && x.target_ip === v.ip);
					if (!owner) {
						if (!visitorCards[v.ip]) {
							const mac = this.view.macOf(v.ip);
							const name = mac ? shortName(this.view.hosts[mac].name) : '';
							visitorCards[v.ip] = pathCard(deviceIcon(this.view.kinds[mac], name), '', name || v.ip, [ name ? v.ip : '', _('Local network') ]);
						}
						routes.push({ from: visitorCards[v.ip], to: card, via: null });
						visitorCards[v.ip].body.appendChild(E('span', { 'class': 'tsv-sub tsv-mobile' }, '→ %s'.format(n.hostname || n.name)));
						continue;
					}
					source = cardOf[owner.ip];
				}
				else if (local.has(v.ip)) {
					source = cardOf[v.ip];
				}
				if (v.lan || local.has(v.ip)) {
					if (source && source !== card && !routes.some((r) => r.local && r.from === source && r.to === card)) {
						routes.push({ from: source, to: card, local: true });
						source.body.appendChild(E('span', { 'class': 'tsv-sub tsv-mobile' }, '→ %s'.format(n.hostname || n.name)));
					}
					continue;
				}
				if (!visitorCards[v.ip])
					visitorCards[v.ip] = pathCard(clientIcon(v.os), '', v.host || v.ip, [ v.user, v.ip ]);
				const via = (v.path === 'direct') ? null : derpCard(v.relay || '?');
				routes.push({ from: visitorCards[v.ip], to: card, via });
				// Shown instead of the drawn routes on narrow screens.
				visitorCards[v.ip].body.appendChild(E('span', { 'class': 'tsv-sub tsv-mobile' }, '→ %s · %s'.format(n.hostname || n.name,
					via ? _('Relay %s').format((regions[v.relay] || {}).name || v.relay) : _('Direct'))));
			}
		}

		const left = Object.values(visitorCards);
		this.routes = routes;

		return E('div', { 'class': routes.some((r) => r.local) ? 'tsv-path tsv-has-local' : 'tsv-path' }, [
			E('div', { 'class': 'tsv-left' }, left.length ? left : [ E('div', { 'class': 'tsv-none' }, _('No visitors')) ]),
			E('div', { 'class': 'tsv-mid' }, Object.values(derpCards)),
			E('div', { 'class': 'tsv-right' }, right.length ? right : [ E('em', {}, _('This section contains no values yet')) ])
		]);
	},

	// Draws one line per route. A relayed route enters its DERP card and
	// leaves it at the same height, so it can be followed across the card;
	// a direct one crosses the DERP column in a lane clear of the cards; a
	// local one, between two nodes of this router, arcs along the right of
	// the node column. To keep crossings few, routes are ordered through
	// the middle by the mean height of their two ends, and attach to the
	// cards in that order. Dots flow along each route from the connecting
	// side, and pointing at a card highlights what it is connected to.
	draw() {
		const box = this.el && this.el.querySelector('.tsv-path');
		if (!box)
			return;
		box.querySelectorAll('svg.tsv-lines').forEach((el) => el.remove());
		box.querySelectorAll('.tsv-card').forEach((el) => { el.style.transform = ''; el.style.minHeight = ''; });
		box.style.minHeight = '';
		if (this.backdrop)
			this.backdrop.fit();
		if (!box.offsetParent || window.getComputedStyle(box.querySelector('.tsv-mid')).gridColumnStart === '1')
			return;  // stacked layout on narrow screens: no lines

		const all = this.routes || [];
		const routes = all.filter((r) => !r.local), locals = all.filter((r) => r.local);
		const centre = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
		const SLOT = 10;

		// A DERP card is tall enough for a slot per route through it.
		for (const el of box.querySelectorAll('.tsv-mid > .tsv-card'))
			el.style.minHeight = (routes.filter((r) => r.via === el).length * SLOT + 24) + 'px';

		// Place the DERP column, then the visitor column, level with the
		// nodes they lead to: each card wants to sit centred on its nodes;
		// in that order they are stacked with a gap so none overlap, and
		// the view grows if the stack runs past its bottom.
		let bottom = 0;
		const place = (col, key) => {
			const items = [ ...box.querySelectorAll(col + ' > .tsv-card') ].map((el) => {
				const r = el.getBoundingClientRect(), t = routes.filter((x) => x[key] === el).map((x) => centre(x.to));
				return { el, top: r.top, height: r.height, want: t.length ? t.reduce((a, b) => a + b, 0) / t.length - r.height / 2 : r.top };
			}).sort((a, b) => a.want - b.want);
			let floor = -Infinity;
			for (const it of items) {
				const y = Math.max(it.want, floor);
				it.el.style.transform = 'translateY(' + (y - it.top).toFixed(1) + 'px)';
				floor = y + it.height + 12;
				bottom = Math.max(bottom, y + it.height);
			}
		};
		place('.tsv-mid', 'via');
		place('.tsv-left', 'from');
		const outer = box.getBoundingClientRect();
		if (bottom > outer.bottom - 8)
			box.style.minHeight = (bottom - outer.top + 16).toFixed(0) + 'px';
		if (this.backdrop)
			this.backdrop.fit();

		const base = box.getBoundingClientRect();
		const spread = (el, list, key, step) => {
			const r = el.getBoundingClientRect();
			const s = list.length > 1 ? Math.min(step, (r.height - 16) / (list.length - 1)) : 0;
			list.forEach((l, i) => { l[key] = r.top + r.height / 2 + (i - (list.length - 1) / 2) * s - base.top; });
		};
		const group = (list, key) => {
			const m = new Map();
			for (const r of list)
				if (r[key])
					m.set(r[key], (m.get(r[key]) || []).concat([ r ]));
			return m;
		};

		// The height a route would pass the middle at if nothing were in
		// its way: half way between its ends. Everything is ordered by it.
		for (const r of routes)
			r.key = (centre(r.from) + centre(r.to)) / 2 - base.top;
		const byKey = (a, b) => a.key - b.key || centre(a.to) - centre(b.to);

		// Relayed routes: a slot in their DERP card.
		for (const [ el, list ] of group(routes, 'via'))
			spread(el, list.sort(byKey), 'ym', SLOT);

		// Direct routes: a lane through the DERP column, the nearest free
		// height to their own, 8 px clear of every DERP card and of lanes
		// taken, lanes keeping the order of the routes.
		const mid = box.querySelector('.tsv-mid').getBoundingClientRect();
		const blocked = [ ...box.querySelectorAll('.tsv-mid > .tsv-card') ].map((el) => {
			const r = el.getBoundingClientRect();
			return [ r.top - base.top - 8, r.bottom - base.top + 8 ];
		});
		const hasDerp = blocked.length > 0;
		const free = (y) => !blocked.some(([ t, b ]) => y > t && y < b);
		let prev = -Infinity;
		for (const r of routes.filter((x) => !x.via).sort(byKey)) {
			let want = Math.max(r.key, prev + 16), up = want, down = want;
			while (!free(down)) down += 2;
			while (!free(up) && up > prev + 16) up -= 2;
			const y = (free(up) && want - up <= down - want) ? up : down;
			blocked.push([ y - 8, y + 8 ]);
			prev = r.ym = y;
		}

		// Attachment points on the visitors' right and the nodes' left
		// edges, in the order the routes pass the middle.
		const byMid = (a, b) => a.ym - b.ym;
		for (const [ el, list ] of group(routes, 'from'))
			spread(el, list.sort(byMid), 'y1', 14);
		for (const [ el, list ] of group(routes, 'to'))
			spread(el, list.sort(byMid), 'y2', 14);

		// Local routes attach to the right edges of their two cards.
		const ends = new Map();
		for (const r of locals) {
			ends.set(r.from, (ends.get(r.from) || []).concat([ { r, key: 'y1', other: r.to } ]));
			ends.set(r.to, (ends.get(r.to) || []).concat([ { r, key: 'y2', other: r.from } ]));
		}
		for (const [ el, list ] of ends) {
			const b = el.getBoundingClientRect();
			list.sort((p, q) => centre(p.other) - centre(q.other));
			const s = list.length > 1 ? Math.min(12, (b.height - 16) / (list.length - 1)) : 0;
			list.forEach((p, i) => { p.r[p.key] = b.top + b.height / 2 + (i - (list.length - 1) / 2) * s - base.top; });
		}

		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('class', 'tsv-lines');
		box.insertBefore(svg, box.firstChild);
		const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const f = (n) => n.toFixed(1);
		const curve = (x1, y1, x2, y2) => {
			const dx = Math.max((x2 - x1) / 2, 16);
			return 'C' + f(x1 + dx) + ' ' + f(y1) + ' ' + f(x2 - dx) + ' ' + f(y2) + ' ' + f(x2) + ' ' + f(y2);
		};
		const add = (r, d, i) => {
			r.g = document.createElementNS(NS, 'g');
			for (const cls of [ 'tsv-wire', 'tsv-flow' ]) {
				const p = r.g.appendChild(document.createElementNS(NS, 'path'));
				p.setAttribute('class', cls);
				p.setAttribute('d', d);
				// The flow: round dots 30 px apart moving along the whole
				// route at 30 px/s, one dash pattern shifted in a loop.
				if (cls === 'tsv-flow' && !still && p.animate)
					p.animate([ { strokeDashoffset: 0 }, { strokeDashoffset: -31.5 } ],
						{ duration: 1050, iterations: Infinity, delay: -(i * 370) % 1050 });
			}
			svg.appendChild(r.g);
		};

		routes.forEach((r, i) => {
			const x1 = r.from.getBoundingClientRect().right - base.left;
			const x2 = r.to.getBoundingClientRect().left - base.left;
			let d = 'M' + f(x1) + ' ' + f(r.y1);
			if (r.via || hasDerp) {
				const v = r.via ? r.via.getBoundingClientRect() : mid;
				d += curve(x1, r.y1, v.left - base.left, r.ym) + 'L' + f(v.right - base.left) + ' ' + f(r.ym) +
					curve(v.right - base.left, r.ym, x2, r.y2);
			}
			else {
				d += curve(x1, r.y1, x2, r.y2);
			}
			add(r, d, i);
		});

		// Local routes: out of the source's right edge, round through the
		// margin kept for them, into the target's right edge; longer arcs
		// further out.
		locals.slice().sort((a, b) => Math.abs(a.y1 - a.y2) - Math.abs(b.y1 - b.y2)).forEach((r, i) => {
			const x = r.from.getBoundingClientRect().right - base.left, out = x + 14 + Math.min(i, 3) * 8;
			const dir = r.y2 > r.y1 ? 1 : -1, rad = Math.min(10, Math.abs(r.y2 - r.y1) / 2);
			add(r, 'M' + f(x) + ' ' + f(r.y1) + 'L' + f(out - rad) + ' ' + f(r.y1) +
				'Q' + f(out) + ' ' + f(r.y1) + ' ' + f(out) + ' ' + f(r.y1 + dir * rad) +
				'L' + f(out) + ' ' + f(r.y2 - dir * rad) +
				'Q' + f(out) + ' ' + f(r.y2) + ' ' + f(out - rad) + ' ' + f(r.y2) +
				'L' + f(x) + ' ' + f(r.y2), routes.length + i);
		});

		// Pointing at a card shows what it is connected to.
		const clear = () => {
			box.classList.remove('tsv-hover');
			box.querySelectorAll('.tsv-hl').forEach((el) => el.classList.remove('tsv-hl'));
		};
		for (const el of box.querySelectorAll('.tsv-card')) {
			el.onmouseleave = clear;
			el.onmouseenter = () => {
				clear();
				const mine = all.filter((r) => r.from === el || r.to === el || r.via === el);
				if (!mine.length)
					return;
				box.classList.add('tsv-hover');
				for (const r of mine)
					[ r.g, r.from, r.to, r.via ].forEach((x) => x && x.classList.add('tsv-hl'));
			};
		}
	},
});

return baseclass.extend({
	Topology,
	stateBadge,
	shortName
});
