import * as ort from 'onnxruntime-web/webgpu';

import { logger } from './logging.mjs';

const MODEL_ID = 'onnx-community/mediapipe_selfie_segmentation_landscape';
const MODEL_REVISION = '2497d5bec26c626c7b3c4edc6e1fefc21b64f6c3';
const MODEL_WIDTH = 256;
const MODEL_HEIGHT = 144;
const MODEL_CACHE_NAME = 'ytlcf-person-detection-v1';

/**
 * Runs the same MediaPipe Selfie Segmentation model used by Firefox on Chrome.
 * The model is downloaded from Hugging Face once and cached in extension storage.
 */
export class ChromePersonDetectionEngine {
	/** @type {"gpu" | "wasm"} */
	#device;
	/** @type {Promise<void> | null} */
	#loading = null;
	/** @type {import('onnxruntime-web').InferenceSession | null} */
	#session = null;
	/** @type {OffscreenCanvas} */
	#canvas = new OffscreenCanvas(MODEL_WIDTH, MODEL_HEIGHT);
	/** @type {OffscreenCanvasRenderingContext2D} */
	#context;

	/** @param {{device: "gpu" | "wasm"}} options */
	constructor({ device }) {
		this.#device = device;
		const context = this.#canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('OffscreenCanvas 2D context is not supported.');
		this.#context = context;
	}

	async ensureReady() {
		if (this.#session) return;
		this.#loading ??= this.#initialize();
		try {
			await this.#loading;
		} finally {
			this.#loading = null;
		}
	}

	async #initialize() {
		ort.env.logLevel = 'error';
		ort.env.wasm.numThreads = 1;
		ort.env.wasm.proxy = false;
		ort.env.wasm.wasmPaths = {
			mjs: new URL('../person_detection/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
			wasm: new URL('../person_detection/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href,
		};

		if (this.#device === 'gpu') {
			try {
				await this.#createSession('gpu');
				return;
			} catch (cause) {
				logger.warn('Chrome WebGPU person detection is unavailable; falling back to WASM:', cause);
			}
		}

		await this.#createSession('wasm');
	}

	/** @param {"gpu" | "wasm"} device */
	async #createSession(device) {
		const modelFile = device === 'gpu' ? 'model.onnx' : 'model_quantized.onnx';
		const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/onnx/${modelFile}`;
		const model = await this.#loadModel(url);
		this.#session = await ort.InferenceSession.create(model, {
			executionProviders: [device === 'gpu' ? 'webgpu' : 'wasm'],
			graphOptimizationLevel: 'all',
		});
		this.#device = device;
		logger.info(`Chrome person detector is ready (${device}).`);
	}

	/** @param {string} url */
	async #loadModel(url) {
		const cache = await caches.open(MODEL_CACHE_NAME);
		const request = new Request(url);
		let response = await cache.match(request);
		if (!response) {
			response = await fetch(request);
			if (!response.ok) throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
			await cache.put(request, response.clone());
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	/** @param {{args: [Blob]}} request */
	async run({ args }) {
		await this.ensureReady();
		const [blob] = args;
		if (!(blob instanceof Blob)) throw new TypeError('Person detector expects a frame Blob.');

		const bitmap = await createImageBitmap(blob);
		let pixels;
		try {
			this.#context.drawImage(bitmap, 0, 0, MODEL_WIDTH, MODEL_HEIGHT);
			pixels = this.#context.getImageData(0, 0, MODEL_WIDTH, MODEL_HEIGHT).data;
		} finally {
			bitmap.close();
		}

		// The model processor rescales RGB pixels to [0, 1] and lays them out as NCHW.
		const inputData = new Float32Array(MODEL_WIDTH * MODEL_HEIGHT * 3);
		const planeSize = MODEL_WIDTH * MODEL_HEIGHT;
		for (let pixel = 0; pixel < planeSize; pixel++) {
			const source = pixel * 4;
			inputData[pixel] = pixels[source] / 255;
			inputData[planeSize + pixel] = pixels[source + 1] / 255;
			inputData[planeSize * 2 + pixel] = pixels[source + 2] / 255;
		}

		const session = this.#session;
		if (!session) throw new Error('Chrome person detector failed to initialize.');
		const input = new ort.Tensor('float32', inputData, [1, 3, MODEL_HEIGHT, MODEL_WIDTH]);
		try {
			const output = await session.run({ [session.inputNames[0]]: input });
			const alpha = output[session.outputNames[0]];
			const values = alpha.data;
			const data = new Uint8Array(planeSize);
			for (let i = 0; i < planeSize; i++) {
				data[i] = Math.round(Math.max(0, Math.min(1, values[i])) * 255);
			}
			alpha.dispose();
			return [{ label: null, score: null, mask: { data, width: MODEL_WIDTH, height: MODEL_HEIGHT, channels: 1 } }];
		} finally {
			input.dispose();
		}
	}
}
