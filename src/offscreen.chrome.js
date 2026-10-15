// @ts-types="npm:@huggingface/transformers@3.8.1"
import { env, pipeline, RawImage } from './vendor/transformers.min.js';

// @ts-expect-error: Polyfill browser API for Chrome 147 or older environments
globalThis.browser ??= chrome;

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = browser.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

/** @type {Promise<import('npm:@huggingface/transformers@3.8.1').ImageSegmentationPipeline> | undefined} */
let engine;

// @ts-expect-error: The Firefox callback types do not allow ignoring unrelated messages.
browser.runtime.onMessage.addListener((msg, sender, respond) => {
	if (!msg || typeof msg !== 'object' || !('ml' in msg) || sender.tab) return;
	const { ml } = /** @type {{ ml: { create?: { modelId: string, device: string, dtype: 'fp32' | 'q8' }, run?: { args: [string] } } }} */ (msg);
	(async () => {
		if (ml.create) {
			const { modelId, device, dtype } = ml.create;
			engine ??= pipeline('image-segmentation', modelId, { device: device === 'gpu' ? 'webgpu' : 'wasm', dtype });
			await engine;
			return;
		}
		if (!engine) throw new DOMException('Person detector is not initialized.', 'NotSupportedError');
		if (!ml.run) throw new TypeError('Expected a video frame.');
		const image = await RawImage.read(ml.run.args[0]);
		/** @type {import('../types/messaging.d.ts').SegmentationResult[]} */
		const result = await (await engine)(image);
		return result.map(({ label, score, mask }) => ({
			label, score,
			mask: { data: Array.from(mask.data), width: mask.width, height: mask.height, channels: mask.channels },
		}));
	})().then(result => respond({ result }), reason => {
		const { name, message } = Error.isError(reason) ? reason : new Error(`${reason}`);
		respond({ error: { name, message } });
	});
	return true;
});
