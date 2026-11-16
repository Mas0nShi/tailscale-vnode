// Logs into LuCI, opens the tailscale-vnode page and takes screenshots.
// Usage: LUCI_URL=https://router LUCI_PASSWORD=... node tools/screenshot.js <outdir>
// Needs playwright-core (npm i playwright-core) and Google Chrome; set
// E2E_MODULES to the node_modules directory holding playwright-core if it
// is installed elsewhere, and CHROME to Chrome's executable if it is not in
// the macOS default place. Prints console errors and failed requests.
const path = require('path');
const { chromium } = require(process.env.E2E_MODULES ? path.join(process.env.E2E_MODULES, 'playwright-core') : 'playwright-core');

const BASE = (process.env.LUCI_URL || 'https://192.168.1.1') + '/cgi-bin/luci';
const out = process.argv[2];

(async () => {
	const browser = await chromium.launch({
		executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		headless: true
	});
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, locale: 'zh-CN' });
	const page = await ctx.newPage();
	const errors = [];
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('response', async (r) => {
		if (r.status() >= 400)
			errors.push(r.status() + ' ' + r.url() + ' ' + (r.request().postData() || '').slice(0, 200));
	});
	page.on('requestfinished', async (req) => {
		if (!/\/ubus/.test(req.url()))
			return;
		const res = await req.response();
		const body = res ? await res.text().catch(() => '') : '';
		// ubus access errors come back as JSON with code -32002
		if (/"code":\s*-32002|Access denied/.test(body))
			errors.push('ubus denied: ' + (req.postData() || '').slice(0, 200));
	});

	await page.goto(BASE + '/');
	await page.fill('input[name="luci_password"]', process.env.LUCI_PASSWORD);
	await Promise.all([ page.waitForNavigation(), page.press('input[name="luci_password"]', 'Enter') ]);

	await page.goto(BASE + '/admin/services/tailscale-vnode');
	await page.waitForSelector('.tsv-path', { timeout: 20000 });
	await page.waitForTimeout(1500);

	await page.screenshot({ path: out + '/desktop-full.png', fullPage: true });
	const topo = await page.$('.tsv-path');
	await topo.screenshot({ path: out + '/desktop-topo.png' });

	// Dialogs
	const shotModal = async (name) => {
		await page.waitForSelector('.modal', { timeout: 10000 });
		await page.waitForTimeout(800);
		await (await page.$('.modal')).screenshot({ path: out + '/' + name + '.png' });
		await page.evaluate(() => L.ui.hideModal());
		await page.waitForTimeout(600);
	};

	await page.click('.cbi-button-add');
	await shotModal('dialog-add');

	const edit = await page.$('table .cbi-button-edit');
	if (edit) { await edit.click(); await shotModal('dialog-edit'); }

	// The Cloudflare DNS section's first button (Set up or Edit).
	const dnsBtn = await page.evaluateHandle(() => {
		const h = [ ...document.querySelectorAll('.cbi-section h3') ].find((x) => /Cloudflare/.test(x.textContent));
		return h && h.parentNode.querySelector('.cbi-section-create button');
	});
	if (dnsBtn.asElement()) { await dnsBtn.asElement().click(); await shotModal('dialog-dns'); }

	// Phone width
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(800);
	await (await page.$('.tsv-path')).screenshot({ path: out + '/mobile-topo.png' });

	console.log(JSON.stringify({ errors }, null, 1));
	await browser.close();
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
