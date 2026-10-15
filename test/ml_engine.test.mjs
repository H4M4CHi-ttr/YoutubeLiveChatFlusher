import './_globals.mjs';
import { assertEquals, assertRejects } from '@std/assert';
import { MLEngineManager } from '../src/modules/ml_engine.chrome.mjs';
import { MLEngineManager as NativeMLEngineManager } from '../src/modules/ml_engine.mjs';

Deno.test('the native engine receives the original frame bytes as a Blob', async () => {
	/** @type {Blob[]} */
	const frames = [];
	const result = [{ label: null, score: null, mask: { data: new Uint8Array([0, 255]), width: 2, height: 1, channels: 1 } }];
	Object.assign(globalThis, { browser: { trial: { ml: {
		createEngine: () => Promise.resolve(),
		runEngine: (/** @type {{ args: Blob[] }} */ request) => {
			frames.push(...request.args);
			return Promise.resolve(result);
		},
	} } } });
	const engine = new NativeMLEngineManager({ device: 'wasm' });
	assertEquals(await engine.run({ args: ['data:image/webp;base64,AQID'] }), result);
	assertEquals(frames[0].type, 'image/webp');
	assertEquals(new Uint8Array(await frames[0].arrayBuffer()), new Uint8Array([1, 2, 3]));
});

Deno.test('concurrent inference waits for one offscreen document and one engine', async () => {
	/** @type {string[]} */
	const calls = [];
	const mask = [{ label: null, score: null, mask: { data: [0, 127, 255], width: 3, height: 1, channels: 1 } }];
	Object.assign(globalThis, { browser: {
		offscreen: {
			hasDocument: () => Promise.resolve(false),
			createDocument: (/** @type {{ url: string }} */ options) => {
				calls.push(options.url);
				return Promise.resolve();
			},
		},
		runtime: { sendMessage: (/** @type {{ ml: { create?: object } }} */ message) => {
			const request = JSON.parse(JSON.stringify(message)).ml;
			calls.push(request.create ? 'create' : 'run');
			return Promise.resolve({ result: request.create ? undefined : mask });
		} },
	} });
	const engine = new MLEngineManager({ device: 'wasm' });
	const request = { args: /** @type {[string]} */ (['data:image/webp;base64,AAAA']) };
	const results = await Promise.all([engine.run(request), engine.run(request)]);
	assertEquals(calls, ['offscreen.html', 'create', 'run', 'run']);
	assertEquals(engine.isReady, true);
	assertEquals(results, [mask, mask]);
});

Deno.test('a restarted service worker reuses the existing offscreen document', async () => {
	Object.assign(globalThis, { browser: {
		offscreen: {
			hasDocument: () => Promise.resolve(true),
			createDocument: () => { throw new Error('Must reuse the existing document'); },
		},
		runtime: { sendMessage: () => Promise.resolve({}) },
	} });
	const engine = new MLEngineManager({ device: 'gpu' });
	await engine.ensureReady();
	assertEquals(engine.isReady, true);
});

Deno.test('initialization failure is reported and does not repeatedly recreate the engine', async () => {
	let attempts = 0;
	Object.assign(globalThis, { browser: {
		offscreen: { hasDocument: () => Promise.resolve(true) },
		runtime: { sendMessage: () => {
			attempts++;
			return Promise.resolve({ error: { name: 'NotSupportedError', message: 'GPU is unavailable' } });
		} },
	} });
	const engine = new MLEngineManager({ device: 'gpu' });
	await assertRejects(() => engine.ensureReady(), DOMException, 'GPU is unavailable');
	await assertRejects(() => engine.run({ args: ['data:image/webp;base64,AAAA'] }), DOMException, 'GPU is unavailable');
	assertEquals(engine.isReady, false);
	assertEquals(attempts, 1);
});

Deno.test('an absent offscreen response is an error rather than an empty mask', async () => {
	Object.assign(globalThis, { browser: {
		offscreen: { hasDocument: () => Promise.resolve(true) },
		runtime: { sendMessage: () => Promise.resolve(undefined) },
	} });
	const engine = new MLEngineManager({ device: 'wasm' });
	await assertRejects(() => engine.ensureReady(), DOMException, 'Person detector did not respond');
});
