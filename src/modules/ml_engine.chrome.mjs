/** @import { MLEngineManagerOptions } from "../../types/ml_engine.d.ts" */
/** @import { SegmentationResult } from "../../types/messaging.d.ts" */

export class MLEngineManager {
	/** @type {Partial<MLEngineManagerOptions.PipelineOptions>} */
	#req;
	/** @type {?Promise<void>} */
	#loading = null;

	/** @param {Partial<MLEngineManagerOptions.PipelineOptions>} req */
	constructor(req) {
		this.#req = req;
		this.isReady = false;
	}

	ensureReady() {
		return this.#loading ??= this.#initialize();
	}

	async #initialize() {
		/** @type {{ hasDocument(): Promise<boolean>, createDocument(options: { url: string, reasons: string[], justification: string }): Promise<void> }} */
		const offscreen = Reflect.get(browser, 'offscreen');
		if (!await offscreen.hasDocument()) {
			await offscreen.createDocument({
				url: 'offscreen.html',
				reasons: ['BLOBS'],
				justification: 'Decode video frames and run person detection locally.',
			});
		}
		await this.#send({ create: this.#req });
		this.isReady = true;
	}

	/** @param {object} request */
	async #send(request) {
		const response = /** @type {{ result?: SegmentationResult[], error?: { name: string, message: string } } | undefined} */ (
			await browser.runtime.sendMessage({ ml: request })
		);
		if (!response) throw new DOMException('Person detector did not respond.', 'OperationError');
		if (response.error) throw new DOMException(response.error.message, response.error.name);
		return response.result;
	}

	/**
	 * @param {{ args: [string] }} req
	 * @returns {Promise<SegmentationResult[]>}
	 */
	async run(req) {
		await this.ensureReady();
		const result = await this.#send({ run: req });
		if (!result) throw new DOMException('Person detector returned no mask.', 'OperationError');
		return result;
	}
}
