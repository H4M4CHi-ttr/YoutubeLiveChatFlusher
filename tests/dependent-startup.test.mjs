// Run: node --test tests/dependent-startup.test.mjs
// Set YTLCF_SOURCE_ROOT to a checkout root to test another revision.
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const sourceRoot = process.env.YTLCF_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(sourceRoot, path), 'utf8');
const controllerSource = read('src/modules/chat_controller.mjs');
const mainSource = read('src/modules/main.mjs');
const frameSource = read('src/chatframe.js');
const settle = () => new Promise(setImmediate);

// Only module bindings are replaced; the production initialization, handshake,
// controller.listen(), close(), and action handling run without modification.
function runModule(source, context, filename) {
	const script = source.replace(/^import .*;?\r?\n/gm, '').replace(/^export /gm, '');
	vm.runInContext(script, context, { filename });
}

function fixture({ live = false, mode = 0 } = {}) {
	const nodes = new Map();
	const processed = [];
	const logs = [];
	let listenCalls = 0;
	let resolveAccount;
	let rejectAccount;
	const account = new Promise((resolve, reject) => {
		resolveAccount = resolve;
		rejectAccount = reject;
	});

	function element(id = '') {
		return Object.assign(new EventTarget(), {
			id, hidden: false, dataset: {}, style: { cssText: '', setProperty() {} },
			classList: { contains: () => false },
			querySelector: () => null,
			getElementById: () => null,
			setAttribute(name, value) { this[name] = value; },
			append(...children) {
				for (const child of children) {
					child.parentElement = this;
					nodes.set(child.id, child);
				}
			},
			after(...children) { this.parentElement?.append(...children); },
			remove() { nodes.delete(this.id); },
		});
	}
	const body = element('body');
	const container = element('movie_player');
	const video = element('video');
	const menu = element('settings-menu');
	body.append(container);
	container.append(video, menu);
	const player = element('app');
	player.tagName = 'YTD-APP';
	player.querySelector = selector => selector === '#movie_player video' ? video
		: selector === '.ytp-settings-menu .ytp-panel-menu' ? menu
		: nodes.get(selector.slice(1)) || null;
	const document = Object.assign(new EventTarget(), {
		body, visibilityState: 'visible',
		getElementById: id => nodes.get(id) || null,
		querySelector: selector => selector === '#movie_player video' ? video : null,
		createElement: () => element(),
	});
	const self = Object.assign(new EventTarget(), { document });
	const store = {
		others: { mode_livestream: mode, mode_replay: mode, layer_autofit: 0, simultaneous: 0 },
		styles: { layer_css: '' }, personDetection: {}, hotkeys: {},
		async load() { return this; },
	};
	const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level =>
		[level, (...args) => logs.push([level, ...args])]));
	const browser = { runtime: { getURL: path => path }, i18n: { getMessage: key => key } };
	const timers = new Map();
	let nextTimer = 0;
	const context = vm.createContext({
		self, document, browser, store, s: store, logger,
		Event, EventTarget, CustomEvent, AbortController,
		LiveChatLayer: class {
			constructor() { this.element = element('yt-lcf-layer'); this.root = element('shadow-root'); }
			hide() { this.element.hidden = true; }
			clear() {}
			autofit() {}
		},
		LiveChatPanel: class {
			constructor() { this.element = element('yt-lcf-panel'); this.form = null; }
			async createForm() {}
		},
		LiveChatLayoutCache: class {
			delete(id) { processed.push(id); return [true]; }
		},
		LiveChatItemFactory: class { async load() {} },
		LiveChatContextMenu: class { constructor() { this.element = element('yt-lcf-context'); } },
		MutationObserver: class { observe() { listenCalls++; } disconnect() {} },
		updateMutedWordsList() {}, updateTlExclusionList() {},
		ReplayActionBuffer: class { size = 0; clear() {} update() {} pushActions() {} },
		getLiveChatActionsAsyncIterable: async function* () {},
		getReplayChatActionsAsyncIterable: async function* () {},
		isNotPip: () => true, isAdShowing: () => false, getText: () => '',
		getValueByJSONPointer: (data, pointer) => pointer === '' ? data : data?.response,
		fetch: url => { assert.equal(url, '/account_advanced'); return account; },
		loadTemplateDocument: async () => ({
			body: { children: ['yt-lcf-cb', 'yt-lcf-pm', 'yt-lcf-pp'].map(element) },
		}),
		setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
		clearInterval(id) { timers.delete(id); },
		setTimeout() {}, // Independent replay's seek timer is outside this regression.
	});
	runModule(controllerSource, context, 'chat_controller.mjs');
	runModule(mainSource, context, 'main.mjs');
	function detail() {
		return {
			pageType: 'watch',
			response: {
				page: 'watch', playerResponse: { videoDetails: { videoId: 'fixture', title: 'Fixture', isLive: live } },
				response: { contents: { twoColumnWatchNextResults: { conversationBar: {
					liveChatRenderer: { continuations: [{ reloadContinuationData: { continuation: 'fixture' } }] },
				} } } },
			},
		};
	}
	context.player = player;
	const start = () => {
		context.initialDetail = detail();
		return vm.runInContext('initialize({ target: player, detail: initialDetail })', context);
	};
	const finishAccount = (fail = false) => fail
		? rejectAccount(new TypeError('Failed to fetch'))
		: resolveAccount({ text: async () => '' });
	return {
		document, logs, nodes, processed,
		start, finishAccount,
		async ready() { const startup = start(); finishAccount(); await startup; await settle(); },
		get listening() { return vm.runInContext('state.controller.listening', context); },
		get disabled() { return nodes.get('yt-lcf-cb')?.['aria-disabled']; },
		get listenCalls() { return listenCalls; },
		navigateStart() { self.dispatchEvent(new Event('yt-navigate-start')); },
		navigateFinish() { self.dispatchEvent(new CustomEvent('yt-navigate-finish', { detail: detail() })); },
		async frame() {
			const frameDocument = new EventTarget();
			const pending = new Map();
			let timerId = 0;
			const frameContext = vm.createContext({
				self: {}, document: frameDocument, top: self, chrome: browser, browser, CustomEvent,
				location: { pathname: live ? '/live_chat' : '/live_chat_replay' },
				importModule: async path => path.includes('store') ? { store } : { logger },
				setInterval(fn) { const id = ++timerId; pending.set(id, fn); return id; },
				clearInterval(id) { pending.delete(id); },
			});
			vm.runInContext(frameSource.replace(/\bimport\(/g, 'importModule('), frameContext, { filename: 'chatframe.js' });
			await settle();
			return {
				get pending() { return pending.size; },
				tick() { for (const fn of [...pending.values()]) fn(); },
				action(id) {
					frameDocument.dispatchEvent(new CustomEvent('yt-action', { detail: {
						actionName: 'yt-live-chat-actions', args: [[{ markChatItemAsDeletedAction: { targetItemId: id } }]],
					} }));
				},
			};
		},
	};
}

for (const live of [false, true]) {
	for (const fail of [false, true]) {
		test(`early ${live ? 'live' : 'replay'} frame retries after account fetch ${fail ? 'rejects' : 'resolves'}`, async () => {
			const page = fixture({ live });
			const startup = page.start();
			const frame = await page.frame();
			assert.ok(page.nodes.has('yt-lcf-layer'), 'Layer exists while start() awaits the account fetch.');
			frame.tick();
			assert.equal(frame.pending, 1, 'An unacknowledged event must be retried.');
			assert.equal(page.listening, false);
			page.finishAccount(fail);
			await startup;
			assert.equal(page.disabled, 'true');
			frame.tick();
			assert.equal(frame.pending, 0);
			assert.equal(page.listening, true);
			assert.equal(page.disabled, 'false');
			assert.equal(page.listenCalls, 1);
			frame.action('initial batch');
			frame.action('next batch');
			assert.deepEqual(page.processed, ['next batch']);
		});
	}
}

test('a late frame starts once and reopening preserves first-batch skipping', async () => {
	const page = fixture();
	await page.ready();
	const first = await page.frame();
	first.tick();
	first.tick();
	assert.equal(page.listenCalls, 1);
	first.action('initial history');
	first.action('before reopen');
	const reopened = await page.frame();
	reopened.tick();
	assert.equal(reopened.pending, 0);
	assert.equal(page.listenCalls, 2);
	reopened.action('reopened history');
	reopened.action('after reopen');
	assert.deepEqual(page.processed, ['before reopen', 'after reopen']);
});

test('SPA navigation aborts the old handshake and an unused first-action listener', async () => {
	const page = fixture();
	await page.ready();
	const oldFrame = await page.frame();
	oldFrame.tick();
	assert.equal(getEventListeners(page.document, 'ytlcf-action').length, 1);
	page.navigateStart(); // No first action arrived before leaving the old video.
	assert.equal(getEventListeners(page.document, 'ytlcf-start').length, 0);
	assert.equal(getEventListeners(page.document, 'ytlcf-action').length, 0);
	const nextFrame = await page.frame();
	nextFrame.tick();
	assert.equal(nextFrame.pending, 1, 'The old page must not acknowledge a new frame.');
	assert.equal(page.listening, false);
	page.navigateFinish();
	assert.equal(getEventListeners(page.document, 'ytlcf-start').length, 1);
	nextFrame.tick();
	assert.equal(nextFrame.pending, 0);
	assert.equal(page.listenCalls, 2, 'Only the current navigation starts a receiver.');
	nextFrame.action('new history');
	nextFrame.action('new message');
	assert.deepEqual(page.processed, ['new message']);
});

test('dependent mode without a chat frame keeps its switch disabled', async () => {
	const page = fixture();
	await page.ready();
	assert.equal(page.disabled, 'true');
	assert.equal(page.listening, false);
	assert.equal(page.listenCalls, 0);
});

for (const live of [false, true]) {
	test(`independent ${live ? 'live' : 'replay'} starts without the frame handshake`, async () => {
		const page = fixture({ live, mode: 1 });
		await page.ready();
		const frame = await page.frame();
		assert.equal(frame.pending, 0);
		assert.equal(getEventListeners(page.document, 'ytlcf-start').length, 0);
		assert.equal(page.listening, true);
		assert.equal(page.disabled, 'false');
		assert.equal(page.listenCalls, 1);
		frame.action('must not forward initial independent-mode frame actions');
		frame.action('must not forward subsequent independent-mode frame actions');
		assert.equal(page.processed.length, 0);
	});
}
