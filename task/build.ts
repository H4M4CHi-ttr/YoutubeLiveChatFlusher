import { copy, expandGlob } from "@std/fs";
import { relative } from "@std/path";
import { Builder } from "#ys-j/zipjs/zip";

const BundleTarget = {
	Chrome: "chrome",
	Firefox: "firefox",
} as const;
type BundleTarget = typeof BundleTarget[keyof typeof BundleTarget];

await Deno.remove("dist/", { recursive: true }).catch(() => {});
await Deno.mkdir("dist");
await bundleFor(BundleTarget.Chrome);
await bundleFor(BundleTarget.Firefox);
await zipFor(BundleTarget.Chrome);
await zipFor(BundleTarget.Firefox);

async function bundleFor(target: BundleTarget) {
	await copy("src", `dist/${target}`);

	const nonTarget: BundleTarget[] = Object.values(BundleTarget).filter(t => t !== target);
	const processing: Promise<void>[] = [];
	for (const t of nonTarget) {
		for await (const { path } of expandGlob(`dist/${target}/**/*.${t}.*`)) {
			processing.push(Deno.remove(path));
		}
	}
	for await (const { path } of expandGlob(`dist/${target}/**/*.${target}.*`)) {
		processing.push(Deno.rename(path, path.replace(`.${target}.`, ".")));
	}
	await Promise.all(processing);

	if (target === BundleTarget.Chrome) {
		await prepareChromePersonDetection();
	} else {
		const swPath = 'dist/firefox/sw.js';
		const sw = await Deno.readTextFile(swPath);
		const chromeImport = "import { ChromePersonDetectionEngine } from './modules/chrome_person_detector.mjs';\n";
		if (!sw.includes(chromeImport)) throw new Error('Chrome person detector import not found in Firefox service worker.');
		await Deno.writeTextFile(swPath, sw.replace(chromeImport, ''));
		await Deno.remove('dist/firefox/modules/chrome_person_detector.mjs');
	}
}

async function prepareChromePersonDetection() {
	const modulePath = 'dist/chrome/modules/chrome_person_detector.mjs';
	const moduleSource = await Deno.readTextFile(modulePath);
	const runtimeImport = "from 'onnxruntime-web/webgpu'";
	if (!moduleSource.includes(runtimeImport)) throw new Error('ONNX Runtime Web import not found in Chrome person detector.');
	await Deno.writeTextFile(modulePath, moduleSource.replace(runtimeImport, "from '../person_detection/ort.webgpu.min.mjs'"));

	const runtimeBundle = new URL(import.meta.resolve('onnxruntime-web/webgpu'));
	const runtimeDirectory = new URL('./', runtimeBundle);
	await Deno.mkdir('dist/chrome/person_detection');
	for (const file of [
		'ort.webgpu.min.mjs',
		'ort-wasm-simd-threaded.jsep.mjs',
		'ort-wasm-simd-threaded.jsep.wasm',
	]) {
		await Deno.copyFile(new URL(file, runtimeDirectory), `dist/chrome/person_detection/${file}`);
	}
	await Deno.copyFile('task/onnxruntime-web.LICENSE', 'dist/chrome/person_detection/onnxruntime-web.LICENSE');
}

async function zipFor(target: BundleTarget) {
	const zipper = new Builder();
	for await (const { path, isFile } of expandGlob(`dist/${target}/**/*`)) {
		if (isFile) {
			const content = await Deno.readFile(path);
			zipper.append(content.buffer, relative(`dist/${target}/`, path));
		}
	}
	const blob = await zipper.build();
	await Deno.writeFile(`dist/${target}.zip`, blob.stream());
}
