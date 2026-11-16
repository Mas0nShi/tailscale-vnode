'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require poll';
'require network';
'require uci';
'require tailscale-vnode.topology as topology';

// SPDX-License-Identifier: GPL-2.0-only

const { shortName, stateBadge } = topology;

// Node changes and the Cloudflare DNS integration take effect at once
// through the tailscale-vnode ubus object: joining needs the auth key while
// the node runs, and keys are never stored for a later apply. Only the
// global settings use LuCI's Save & Apply.

const callStatus = rpc.declare({
	object: 'tailscale-vnode',
	method: 'status',
	expect: { nodes: [] }
});

const callTopology = rpc.declare({
	object: 'tailscale-vnode',
	method: 'topology'
});

const callLogin = rpc.declare({
	object: 'tailscale-vnode',
	method: 'login',
	params: [ 'node', 'authkey' ]
});

const callLogout = rpc.declare({
	object: 'tailscale-vnode',
	method: 'logout',
	params: [ 'node' ]
});

const callAdd = rpc.declare({
	object: 'tailscale-vnode',
	method: 'add',
	params: [ 'node', 'target', 'hostname', 'tags', 'dns', 'dns_name', 'icon' ]
});

const callUpdate = rpc.declare({
	object: 'tailscale-vnode',
	method: 'update',
	params: [ 'node', 'target', 'hostname', 'tags', 'enabled', 'port', 'extra_args', 'dns', 'dns_name', 'icon' ]
});

const callDelete = rpc.declare({
	object: 'tailscale-vnode',
	method: 'delete',
	params: [ 'node' ]
});

// ACL tags in use on devices the router can see.
const callTags = rpc.declare({
	object: 'tailscale-vnode',
	method: 'tags',
	expect: { tags: [] }
});

const callDnsInfo = rpc.declare({
	object: 'tailscale-vnode',
	method: 'dns_info'
});

const callDnsZones = rpc.declare({
	object: 'tailscale-vnode',
	method: 'dns_zones',
	params: [ 'token' ]
});

const callDnsConfigure = rpc.declare({
	object: 'tailscale-vnode',
	method: 'dns_configure',
	params: [ 'token', 'suffix' ]
});

const callDnsDisable = rpc.declare({
	object: 'tailscale-vnode',
	method: 'dns_disable',
	params: [ 'remove_records', 'forget_token' ]
});

const callDnsSync = rpc.declare({
	object: 'tailscale-vnode',
	method: 'dns_sync'
});

// A node's committed configuration, for the edit dialog.
const callNodeConfig = rpc.declare({
	object: 'uci',
	method: 'get',
	params: [ 'config', 'section' ],
	expect: { values: {} }
});

// DHCP leases, static DHCP hosts and neighbours, keyed by MAC address.
const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

const TS_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';
const CF_TOKENS_URL = 'https://dash.cloudflare.com/?to=/:account/api-tokens';

const RE_MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const RE_IP4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const RE_HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const RE_TAG = /^tag:[A-Za-z0-9-]+$/;
const RE_NODE = /^[A-Za-z0-9_]{1,32}$/;
const RE_FQDN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const fqdn = (s) => (s || '').trim().replace(/^\.+|\.+$/g, '').toLowerCase();

function ip4int(ip) {
	return ip.split('.').reduce((acc, octet) => acc * 256 + (+octet), 0);
}

// Subnets of every interface except the upstream ones, and the router's own
// addresses on them: host hints also include WAN neighbours such as the
// upstream gateway, which are rarely the intended target.
function localSubnets(networks) {
	const subnets = [], own = new Set();
	for (const net of networks) {
		if (/^(wan|wan6|loopback)$/.test(net.getName()))
			continue;
		for (const cidr of net.getIPAddrs() || []) {
			const [ addr, len ] = cidr.split('/');
			const bits = +len;
			const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
			subnets.push([ (ip4int(addr) & mask) >>> 0, mask ]);
			own.add(addr);
		}
	}
	return {
		contains: (ip) => !own.has(ip) && subnets.some(([ base, mask ]) => ((ip4int(ip) & mask) >>> 0) === base)
	};
}

// What went wrong with a login, in one sentence; the raw message is shown
// under it.
function loginHint(message) {
	let m;
	if ((m = /non-existent tag:? *(tag:[A-Za-z0-9-]+)/.exec(message)))
		return _('Tag %s does not exist in the tailnet ACL. Create a key with an existing tag.').format(m[1]);
	if (/requested tags .*(invalid|not permitted)/.test(message))
		return _('The key may not use this node\'s tags.');
	if (/invalid key|key (not found|expired)|expired/i.test(message))
		return _('The key is invalid, expired or already used.');
	if (/timeout|context deadline/i.test(message))
		return _('Timed out. Check that the router can reach Tailscale.');
	return _('Could not join the tailnet.');
}

// Polls the status until node `name` passes `test`; rejects after `seconds`.
function waitNode(name, test, seconds) {
	const deadline = Date.now() + seconds * 1000;
	const attempt = () => L.resolveDefault(callStatus(), []).then((nodes) => {
		const n = nodes.find((x) => x.name === name);
		if (n && test(n))
			return n;
		if (Date.now() > deadline)
			return Promise.reject(n);
		return sleep(1000).then(attempt);
	});
	return attempt();
}

// A Tailscale machine name suggested from a DHCP host name.
function suggestHostname(name) {
	return (name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

// A full-width input for an auth key or API token, never autofilled.
function secretInput(placeholder) {
	return E('input', {
		'type': 'password', 'class': 'cbi-input-password', 'style': 'width:100%',
		'placeholder': placeholder || '', 'autocomplete': 'off'
	});
}

function link(href, text) {
	return E('a', { 'href': href, 'target': '_blank', 'rel': 'noopener noreferrer' }, text);
}

// A form row. The field column may shrink below its content and
// descriptions wrap, or long text runs out of dialogs in flexbox themes.
function field(title, widget, help) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, title),
		E('div', { 'class': 'cbi-value-field', 'style': 'min-width:0;flex:1' }, [
			widget,
			help ? E('div', { 'class': 'cbi-value-description', 'style': 'white-space:normal;overflow-wrap:anywhere' }, help) : ''
		])
	]);
}

// LuCI-style tabs, as in LuCI's own edit dialogs: [[title, content], ...].
function tabs(list) {
	const menu = E('ul', { 'class': 'cbi-tabmenu' });
	const panes = list.map(([ title, content ], i) => {
		menu.appendChild(E('li', { 'class': i ? 'cbi-tab-disabled' : 'cbi-tab' }, E('a', {
			'href': '#',
			'click': (ev) => {
				ev.preventDefault();
				menu.querySelectorAll('li').forEach((li, j) => { li.className = (j === i) ? 'cbi-tab' : 'cbi-tab-disabled'; });
				panes.forEach((p, j) => { p.style.display = (j === i) ? '' : 'none'; });
			}
		}, title)));
		return E('div', { 'style': i ? 'display:none' : '' }, content);
	});
	return E('div', {}, [ menu ].concat(panes));
}

function errorBox() {
	const el = E('div');
	el.show = (msg, raw) => el.replaceChildren(E('div', { 'class': 'alert-message warning' }, [
		E('p', msg), raw ? E('pre', { 'style': 'white-space:pre-wrap' }, raw) : ''
	]));
	el.clear = () => el.replaceChildren();
	return el;
}

// LuCI's themed checkbox (a bare <input> does not line up in the themes).
function checkbox(checked, onChange) {
	const widget = new ui.Checkbox(checked ? '1' : '0', { value_enabled: '1', value_disabled: '0' });
	const el = widget.render();
	if (onChange)
		el.addEventListener('change', onChange);
	return { el, checked: () => widget.getValue() === '1' };
}

// Combobox/DynamicList have no runtime disabled state.
function setLocked(el, locked) {
	el.style.pointerEvents = locked ? 'none' : '';
	el.style.opacity = locked ? '.6' : '';
}

// Runs `fn` with `buttons` disabled and the first one spinning.
function busy(buttons, fn) {
	buttons.forEach((b) => { b.disabled = true; });
	buttons[0].classList.add('spinning');
	return Promise.resolve().then(fn).finally(() => {
		buttons.forEach((b) => { b.disabled = false; });
		buttons[0].classList.remove('spinning');
	});
}


// The icons a node can be given, in the order they are offered.
const NODE_ICONS = [ [ '', () => _('Default') ], [ 'desktop', () => _('Desktop') ], [ 'laptop', () => _('Laptop') ],
	[ 'server', () => _('Server') ], [ 'phone', () => _('Phone') ] ];

function iconSelect(value) {
	const sel = E('select', { 'class': 'cbi-input-select' }, NODE_ICONS.map(([ k, label ]) => E('option', { 'value': k }, label())));
	sel.value = value || '';
	return sel;
}


return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callStatus(), []),
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(network.getNetworks(), []),
			L.resolveDefault(callTags(), []),
			L.resolveDefault(callDnsInfo(), {}),
			L.resolveDefault(callTopology(), {}),
			// Icons chosen for clients in the Vantage theme, if it is there.
			L.resolveDefault(uci.load('vantage').then(() => uci.sections('vantage', 'client')), [])
		]);
	},

	/* ---- Host hints ---- */

	// The MAC address of the host hint holding IPv4 address ip, or ''.
	macOf(ip) {
		return Object.keys(this.hosts).find((m) => (this.hosts[m].ipaddrs || []).includes(ip)) || '';
	},

	/* ---- Pickers shared by the dialogs ---- */

	hostLabel(mac) {
		const h = this.hosts[mac] || {};
		const ip = (h.ipaddrs || []).find(this.lan.contains) || (h.ipaddrs || [])[0];
		return '%s (%s)'.format(shortName(h.name) || mac, ip || _('no address'));
	},

	// LAN hosts to choose from, or any MAC/IPv4 address typed in.
	targetPicker(value) {
		const choices = {};
		for (const mac of this.choices)
			choices[mac] = this.hostLabel(mac);
		if (value && !(value in choices))
			choices[value] = value;

		const widget = new ui.Combobox(value || '', choices, {
			sort: true,
			select_placeholder: _('Select a host'),
			custom_placeholder: _('MAC or IPv4 address')
		});
		return { widget, el: widget.render() };
	},

	tagPicker(values) {
		const choices = {};
		for (const t of this.tags.concat(values))
			choices[t] = t;
		const widget = new ui.DynamicList(values, choices, { create: true, custom_placeholder: 'tag:name' });
		return { widget, el: widget.render() };
	},

	// The record name a node gets unless it has its own.
	defaultRecord(hostname) {
		return (this.dns.suffix && hostname) ? '%s.%s'.format(hostname.toLowerCase(), this.dns.suffix) : '';
	},

	// One row for the add/edit dialogs: the record name (placeholder: the
	// default), then an Enable checkbox. Null while Cloudflare DNS is off.
	dnsFields(on, name, hostnameInput) {
		if (!this.dns.enabled)
			return null;

		const input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'value': name || '' });
		const sync = () => {
			input.placeholder = this.defaultRecord(hostnameInput.value.trim());
			input.disabled = !check.checked();
		};
		const check = checkbox(on, sync);
		hostnameInput.addEventListener('input', sync);
		sync();

		return {
			// The input grows up to the theme's field width (themes cap it with
			// max-width), with the checkbox and its label right after it.
			el: field(_('Cloudflare DNS'), E('div', { 'style': 'display:flex;align-items:center;flex-wrap:nowrap;gap:8px' }, [
				(input.style.cssText = 'flex:1 1 auto;width:auto;min-width:0', input),
				check.el,
				E('span', {
					'style': 'white-space:nowrap;cursor:pointer',
					'click': () => check.el.querySelector('input[type="checkbox"]').click()
				}, _('Enable'))
			])),
			on: () => check.checked(),
			name: () => fqdn(input.value),
			validate: () => (check.checked() && input.value.trim() && !RE_FQDN.test(fqdn(input.value)))
				? _('Invalid DNS name') : null
		};
	},

	validateNode(target, hostname, tags) {
		if (!RE_MAC.test(target) && !RE_IP4.test(target))
			return _('Select a host or enter a MAC or IPv4 address.');
		if (!RE_HOSTNAME.test(hostname))
			return _('Invalid Tailscale name');
		for (const tag of tags)
			if (!RE_TAG.test(tag))
				return _('Invalid tag: %s').format(tag);
		return null;
	},

	/* ---- Node table ---- */

	renderTarget(n) {
		let name, ip;
		if (RE_MAC.test(n.target || '')) {
			name = shortName((this.hosts[n.target.toUpperCase()] || {}).name);
			ip = n.target_ip;
		}
		else {
			ip = n.target;
			const mac = this.macOf(ip);
			name = mac ? shortName(this.hosts[mac].name) : '';
		}

		if (!name)
			return ip || E('em', {}, _('no address'));
		return E('span', {}, [ name, E('br'), E('small', {}, ip || _('no address')) ]);
	},

	// The Tailscale address and at most one name that resolves: the
	// Cloudflare record when it is published, else the full MagicDNS name
	// when MagicDNS is on. A DNS problem adds a line.
	renderAddress(n) {
		const dns = this.dns.enabled && this.dns.tokenSet && n.record;
		const name = (dns && n.record_state === 'ok') ? n.record
			: (n.magic_dns ? (n.dns_name || '').replace(/\.$/, '') : '');
		const out = [ n.ip || '-' ];

		if (n.ip && name)
			out.push(E('br'), E('small', {}, name));
		if (dns && n.record_state === 'conflict')
			out.push(E('br'), E('small', { 'class': 'label warning' }, _('DNS: name taken by another record')));
		else if (dns && n.record_state === 'error')
			out.push(E('br'), E('small', { 'class': 'label warning' }, _('DNS: %s').format(n.record_message)));
		return E('span', {}, out);
	},

	renderActions(n) {
		const btn = (cls, label, handler) => E('button', {
			'class': 'btn ' + cls,
			'click': ui.createHandlerFn(this, handler, n.name)
		}, label);
		const daemon = n.enabled && n.state && n.state !== 'stopped' && n.state !== 'unreachable';
		const actions = [];

		if (daemon && n.state !== 'Running')
			actions.push(btn('cbi-button-action', _('Join tailnet'), 'handleLogin'));
		actions.push(btn('cbi-button-edit', _('Edit'), 'handleEditNode'));
		actions.push(btn('cbi-button-remove', _('Delete'), 'handleDeleteNode'));

		return E('div', {}, actions.reduce((acc, b) => acc.concat(acc.length ? [ ' ', b ] : [ b ]), []));
	},

	renderRows(nodes) {
		return nodes.map((n) => [
			E('strong', {}, n.hostname || n.name),
			this.renderTarget(n),
			stateBadge(n),
			this.renderAddress(n),
			this.renderActions(n)
		]);
	},

	// Called by LuCI's poll, so it follows the page's auto-refresh switch.
	refresh() {
		return Promise.all([
			L.resolveDefault(callStatus(), []),
			L.resolveDefault(callTopology(), {})
		]).then(([ nodes, topo ]) => {
			this.nodes = nodes;
			cbi_update_table(this.nodeTable, this.renderRows(nodes),
				E('em', _('This section contains no values yet')));
			this.topology.update(topo);
		});
	},


	/* ---- Join, leave, visitors ---- */

	handleLogin(name) {
		const key = secretInput('tskey-auth-');
		const error = errorBox();
		const submit = E('button', { 'class': 'btn cbi-button-action' }, _('Join'));
		const cancel = E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel'));

		submit.addEventListener('click', ui.createHandlerFn(this, () => {
			if (!key.value.trim())
				return;
			error.clear();
			return busy([ submit, cancel ], () => callLogin(name, key.value.trim()).then((res) => {
				if (res && res.ok) {
					ui.hideModal();
					return this.refresh();
				}
				const msg = (res && res.message) || '';
				error.show(loginHint(msg), msg);
				key.value = '';
			}));
		}));

		ui.showModal(_('Join tailnet: %s').format(name), [
			field(_('Auth key'), key, [ _('Must carry the node\'s tags.'), ' ', link(TS_KEYS_URL, _('Generate key')) ]),
			error,
			E('div', { 'class': 'right' }, [ cancel, ' ', submit ])
		]);
		key.focus();
	},

	handleLogout(name) {
		if (!confirm(_('Log %s out of the tailnet?').format(name)))
			return;

		return callLogout(name).then((res) => {
			ui.hideModal();
			if (!res || !res.ok)
				ui.addNotification(null, E('pre', (res && res.message) || ''), 'error');
			return this.refresh();
		});
	},


	/* ---- Add ---- */

	// Creates the node, starts it and, with a key, joins it, showing the
	// current step. A failed join keeps the node and allows another key.
	handleAddNode() {
		const target = this.targetPicker('');
		const tags = this.tagPicker([]);
		const hostname = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'maxlength': 63 });
		const key = secretInput('tskey-auth-');
		const nodeId = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('automatic'), 'maxlength': 32 });
		const iconSel = iconSelect('');
		const dns = this.dnsFields(true, '', hostname);
		const progress = E('p');
		const error = errorBox();

		let nameEdited = false, created = null;
		hostname.addEventListener('input', (ev) => { if (ev.isTrusted) nameEdited = hostname.value !== ''; });
		target.el.addEventListener('cbi-dropdown-change', () => {
			const h = this.hosts[(target.widget.getValue() || '').toUpperCase()];
			if (!nameEdited && h && h.name) {
				hostname.value = suggestHostname(shortName(h.name));
				hostname.dispatchEvent(new Event('input'));
			}
		});

		const submit = E('button', { 'class': 'btn cbi-button-action' });
		const cancel = E('button', { 'class': 'btn', 'click': () => { ui.hideModal(); if (created) this.refresh(); } }, _('Cancel'));
		const label = () => {
			submit.textContent = created ? _('Retry') : (key.value.trim() ? _('Create and join') : _('Create'));
		};
		key.addEventListener('input', label);
		label();

		const show = (text) => progress.replaceChildren(E('span', { 'class': 'spinning' }, text));
		const done = (text) => {
			progress.replaceChildren(text);
			submit.style.display = 'none';
			cancel.textContent = _('Close');
		};

		const lock = () => {
			hostname.disabled = nodeId.disabled = true;
			setLocked(target.el, true);
			setLocked(tags.el, true);
			if (dns)
				dns.el.querySelectorAll('input').forEach((el) => { el.disabled = true; });
		};

		const create = () => {
			const t = (target.widget.getValue() || '').trim();
			const h = hostname.value.trim();
			const tg = tags.widget.getValue();
			const problem = this.validateNode(t, h, tg) ||
				((nodeId.value && !RE_NODE.test(nodeId.value)) ? _('Invalid node ID') : null) ||
				(dns ? dns.validate() : null);
			if (problem)
				return Promise.reject(problem);

			show(_('Creating node'));
			return callAdd(nodeId.value || '', t, h, tg, dns ? dns.on() : true, dns ? dns.name() : '', iconSel.value).then((res) => {
				if (!res || !res.ok)
					return Promise.reject((res && res.message) || _('Could not create the node.'));
				created = res.node;
				lock();
				show(_('Starting node'));
				return waitNode(created, (n) => n.state && n.state !== 'stopped' && n.state !== 'unreachable', 20)
					.catch(() => Promise.reject(_('The node did not start. See the system log.')));
			});
		};

		const join = () => {
			show(_('Joining tailnet'));
			return callLogin(created, key.value.trim()).then((res) => {
				key.value = '';
				if (!res || !res.ok) {
					const msg = (res && res.message) || '';
					progress.replaceChildren();
					error.show(loginHint(msg), msg);
					return;
				}
				show(_('Waiting for address'));
				return waitNode(created, (n) => !!n.ip, 15).then(
					(n) => done(_('Joined as %s').format(n.ip)),
					() => done(_('Joined; the address will appear in the list.')));
			});
		};

		submit.addEventListener('click', ui.createHandlerFn(this, () => {
			error.clear();
			return busy([ submit, cancel ], () =>
				(created ? Promise.resolve() : create()).then(() => {
					if (!key.value.trim())
						return done(_('Created. Join the tailnet from the node list.'));
					return join();
				}).catch((msg) => {
					progress.replaceChildren();
					if (msg)
						error.show(String(msg));
				})
			).then(label);
		}));

		ui.showModal(_('Add node'), [
			tabs([
				[ _('General Settings'), [
					field(_('Target'), target.el),
					field(_('Tailscale name'), hostname),
					field(_('Tags'), tags.el),
					dns ? dns.el : '',
					field(_('Auth key'), key, [ _('Optional.'), ' ', link(TS_KEYS_URL, _('Generate key')) ])
				] ],
				[ _('Advanced Settings'), [
					field(_('Icon'), iconSel),
					field(_('Node ID'), nodeId, _('Cannot be changed later.'))
				] ]
			]),
			progress,
			error,
			E('div', { 'class': 'right' }, [ cancel, ' ', submit ])
		]);
	},

	/* ---- Edit ---- */

	handleEditNode(name) {
		return Promise.all([
			L.resolveDefault(callNodeConfig('tailscale-vnode', name), {}),
			L.resolveDefault(callStatus(), [])
		]).then(([ conf, nodes ]) => {
			const status = nodes.find((n) => n.name === name) || {};
			const target = this.targetPicker(conf.target || '');
			const tags = this.tagPicker(L.toArray(conf.tag));
			const hostname = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'maxlength': 63, 'value': conf.hostname || name });
			const enabled = checkbox(conf.enabled !== '0');
			const port = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'min': 1, 'max': 65535, 'value': conf.port || '', 'placeholder': status.port ? String(status.port) : '' });
			const extra = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%', 'value': conf.extra_args || '' });
			const iconSel = iconSelect(conf.icon);
			const dns = this.dnsFields(conf.dns !== '0', conf.dns_name, hostname);
			const error = errorBox();

			const save = E('button', { 'class': 'btn cbi-button-save' }, _('Save'));
			const cancel = E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel'));
			const leave = (status.state === 'Running')
				? E('button', { 'class': 'btn cbi-button-negative', 'style': 'float:left', 'click': ui.createHandlerFn(this, 'handleLogout', name) }, _('Leave tailnet'))
				: '';

			save.addEventListener('click', ui.createHandlerFn(this, () => {
				const t = (target.widget.getValue() || '').trim();
				const h = hostname.value.trim();
				const tg = tags.widget.getValue();
				const problem = this.validateNode(t, h, tg) ||
					((port.value && !(+port.value >= 1 && +port.value <= 65535)) ? _('Invalid port') : null) ||
					(dns ? dns.validate() : null);
				if (problem)
					return error.show(problem);

				error.clear();
				// With Cloudflare DNS off, the node's DNS settings stay as they are.
				return busy([ save, cancel ], () => callUpdate(name, t, h, tg, enabled.checked(), port.value, extra.value.trim(),
					dns ? dns.on() : conf.dns !== '0', dns ? dns.name() : (conf.dns_name || ''), iconSel.value).then((res) => {
					if (!res || !res.ok)
						return error.show((res && res.message) || _('Could not save.'));
					ui.hideModal();
					return sleep(1500).then(() => this.refresh());
				}));
			}));

			ui.showModal(_('Edit node: %s').format(name), [
				tabs([
					[ _('General Settings'), [
						field(_('Enable'), enabled.el),
						field(_('Target'), target.el),
						field(_('Tailscale name'), hostname),
						field(_('Tags'), tags.el, _('Applied the next time the node joins.')),
						dns ? dns.el : ''
					] ],
					[ _('Advanced Settings'), [
						field(_('Icon'), iconSel),
						field(_('UDP port'), port),
						field(_('Extra arguments'), extra, _('Passed to tailscale up.'))
					] ]
				]),
				error,
				E('div', { 'class': 'right' }, [ leave, cancel, ' ', save ])
			]);
		});
	},

	/* ---- Delete ---- */

	handleDeleteNode(name) {
		const error = errorBox();
		const del = E('button', { 'class': 'btn cbi-button-negative' }, _('Delete'));
		const cancel = E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel'));

		del.addEventListener('click', ui.createHandlerFn(this, () => busy([ del, cancel ], () => callDelete(name).then((res) => {
			if (!res || !res.ok)
				return error.show((res && res.message) || _('Could not delete the node.'));
			ui.hideModal();
			if (res.message)
				ui.addNotification(null, E('p', _('The DNS record of %s could not be removed: %s').format(name, res.message)), 'warning');
			return this.refresh();
		}))));

		ui.showModal(_('Delete node: %s').format(name), [
			E('p', _('The node leaves the tailnet. This cannot be undone.')),
			error,
			E('div', { 'class': 'right' }, [ cancel, ' ', del ])
		]);
	},

	/* ---- Cloudflare DNS ---- */

	// A key/value table like LuCI's status overview, buttons below it.
	renderDns() {
		const d = this.dns;
		const btn = (cls, label, handler) => E('button', { 'class': 'btn ' + cls, 'click': ui.createHandlerFn(this, handler) }, label);
		const row = (key, value) => E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'width': '33%' }, key),
			E('td', { 'class': 'td left' }, value)
		]);

		// While disabled with records kept, the domain is still shown.
		const rows = [ row(_('Status'), d.enabled ? _('Enabled') : _('Disabled')) ];
		if (d.suffix)
			rows.push(row(_('Domain'), d.suffix));
		if (d.enabled && !d.tokenSet)
			rows.push(row(_('API token'), E('span', { 'class': 'label warning' }, _('Not set'))));

		const buttons = d.enabled
			? [ btn('cbi-button-edit', _('Edit'), 'handleDnsSetup'), ' ',
			    btn('', _('Sync'), 'handleDnsSync'), ' ',
			    btn('cbi-button-negative', _('Disable'), 'handleDnsDisable') ]
			: [ btn('cbi-button-action', _('Set up'), 'handleDnsSetup') ];

		return E('div', {}, [
			E('table', { 'class': 'table' }, rows),
			E('div', { 'class': 'cbi-section-create' }, buttons)
		]);
	},

	updateDns() {
		this.dnsEl.replaceChildren(this.renderDns());
		return this.refresh();
	},

	handleDnsSync(ev) {
		return busy([ ev.currentTarget ], () => callDnsSync().then(() => sleep(4000)).then(() => this.refresh()));
	},

	// Asks Cloudflare which zones the token can manage and offers them as
	// the domain; a subdomain of one of them can be typed in.
	handleDnsSetup() {
		const d = this.dns;
		const token = secretInput(d.tokenSet ? _('unchanged') : '');
		const domainBox = E('div');
		const error = errorBox();
		const submit = E('button', { 'class': 'btn cbi-button-action' }, d.enabled ? _('Save') : _('Enable'));
		const cancel = E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel'));

		let zones = [], domain = null;

		const renderDomain = (value) => {
			const choices = {};
			zones.forEach((z) => { choices[z] = z; });
			if (value && !(value in choices))
				choices[value] = value;
			domain = new ui.Combobox(value || '', choices, {
				select_placeholder: zones.length ? _('Select a zone') : _('Enter the API token first'),
				custom_placeholder: 'nodes.example.com'
			});
			domainBox.replaceChildren(domain.render());
		};

		const loadZones = () => {
			const t = token.value.trim();
			if (!t && !d.tokenSet)
				return Promise.resolve();
			error.clear();
			domainBox.replaceChildren(E('em', { 'class': 'spinning' }, _('Loading zones')));
			return callDnsZones(t).then((res) => {
				zones = (res && res.ok && res.zones) || [];
				if (!res || !res.ok)
					error.show(_('Cloudflare rejected the token.'), (res && res.message) || '');
				else if (!zones.length)
					error.show(_('The token cannot manage any zone.'));
				renderDomain(d.suffix);
			});
		};

		token.addEventListener('change', loadZones);

		submit.addEventListener('click', ui.createHandlerFn(this, () => {
			const t = token.value.trim();
			const s = domain ? fqdn(domain.getValue()) : '';
			if (!t && !d.tokenSet)
				return error.show(_('Enter the API token.'));
			if (!RE_FQDN.test(s))
				return error.show(_('Select or enter a domain.'));
			if (zones.length && !zones.some((z) => s === z || s.endsWith('.' + z)))
				return error.show(_('%s is not in a zone the token can manage.').format(s));

			error.clear();
			return busy([ submit, cancel ], () => callDnsConfigure(t, s).then((res) => {
				if (!res || !res.ok)
					return error.show(_('Nothing was changed.'), (res && res.message) || '');
				ui.hideModal();
				Object.assign(this.dns, { enabled: true, suffix: s, tokenSet: true });
				return this.updateDns().then(() => sleep(4000)).then(() => this.refresh());
			}));
		}));

		ui.showModal(_('Cloudflare DNS'), [
			field(_('API token'), token, [
				_('Account API token with Zone DNS Edit and Zone Read.'), ' ',
				link(CF_TOKENS_URL, _('Create token'))
			]),
			field(_('Domain'), domainBox),
			error,
			E('div', { 'class': 'right' }, [ cancel, ' ', submit ])
		]);

		renderDomain(d.suffix);
		if (d.tokenSet)
			loadZones();
		else
			token.focus();
	},

	handleDnsDisable() {
		// Both unchecked by default: records and token are kept.
		const remove = checkbox(false);
		const forget = checkbox(false);
		const submit = E('button', { 'class': 'btn cbi-button-negative' }, _('Disable'));
		const cancel = E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel'));

		submit.addEventListener('click', ui.createHandlerFn(this, () => busy([ submit, cancel ], () =>
			callDnsDisable(remove.checked(), forget.checked()).then((res) => {
				ui.hideModal();
				Object.assign(this.dns, {
					enabled: false,
					suffix: remove.checked() ? '' : this.dns.suffix,
					tokenSet: this.dns.tokenSet && !forget.checked()
				});
				if (res && res.complete === false)
					ui.addNotification(null, E('pre', { 'style': 'white-space:pre-wrap' }, res.message || ''), 'warning');
				return this.updateDns();
			}))));

		ui.showModal(_('Disable Cloudflare DNS'), [
			field(_('Delete records'), remove.el),
			field(_('Delete API token'), forget.el),
			E('div', { 'class': 'right' }, [ cancel, ' ', submit ])
		]);
	},

	/* ---- Page ---- */

	render([ nodes, hints, networks, tags, dnsInfo, topo, clients ]) {
		let m, s, o;

		this.kinds = {};
		for (const c of (clients || []))
			if (c.mac && c.icon)
				this.kinds[c.mac.toUpperCase()] = c.icon;

		dnsInfo = dnsInfo || {};
		this.dns = {
			enabled: !!dnsInfo.enabled,
			suffix: fqdn(dnsInfo.suffix),
			tokenSet: !!dnsInfo.token_set
		};

		// Every hint is kept for naming targets in the table; only LAN hosts
		// are offered as choices.
		this.lan = localSubnets(networks);
		this.tags = tags || [];
		this.hosts = {};
		this.choices = [];
		for (const mac in hints) {
			const h = hints[mac];
			const ips = h.ipaddrs || [];
			this.hosts[mac.toUpperCase()] = h;
			if (ips.some(this.lan.contains) || (!ips.length && h.name))
				this.choices.push(mac.toUpperCase());
		}

		this.nodeTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Name')),
				E('th', { 'class': 'th' }, _('Target')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Tailscale address')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		]);
		this.nodes = nodes;
		cbi_update_table(this.nodeTable, this.renderRows(nodes),
			E('em', _('This section contains no values yet')));
		poll.add(() => this.refresh(), 10);

		this.dnsEl = E('div', {}, this.renderDns());
		this.topology = new topology.Topology(this);
		this.topology.update(topo);

		// The title, node table and DNS section live outside the form: the
		// form only holds the global settings, and its Reset re-renders the
		// form alone.
		m = new form.Map('tailscale-vnode');

		s = m.section(form.NamedSection, 'globals', 'globals', _('Global Settings'));
		s.addremove = false;

		o = s.option(form.Value, 'subnet', _('Link network'),
			_('Must not overlap other networks. Changing it restarts all nodes.'));
		o.datatype = 'cidr4';
		o.placeholder = '198.51.100.0/24';
		o.validate = function(section_id, value) {
			return (value && /^169\.254\./.test(value)) ? _('Link-local networks are not supported') : true;
		};

		o = s.option(form.Value, 'base_port', _('Base UDP port'));
		o.datatype = 'port';
		o.placeholder = '41642';

		o = s.option(form.Flag, 'inbound', _('Inbound connections'),
			_('Opens each node\'s UDP port on the router, so that devices on the upstream network can connect directly instead of through a relay.'));
		o.rmempty = false;

		return m.render().then((mapEl) => E('div', {}, [
			E('h2', { 'name': 'content' }, _('Tailscale Virtual Nodes')),
			E('div', { 'class': 'cbi-map-descr' }, _('Give LAN hosts their own Tailscale device without installing Tailscale on them.')),
			E('div', { 'class': 'cbi-section' }, [ E('h3', _('Connections')), this.topology.el ]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Nodes')),
				this.nodeTable,
				E('div', { 'class': 'cbi-section-create' }, E('button', {
					'class': 'cbi-button cbi-button-add',
					'click': ui.createHandlerFn(this, 'handleAddNode')
				}, _('Add node')))
			]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', _('Cloudflare DNS')), this.dnsEl ]),
			mapEl
		]));
	}
});
