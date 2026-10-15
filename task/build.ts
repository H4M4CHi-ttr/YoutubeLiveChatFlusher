import { copy, expandGlob } from "@std/fs";
import { relative } from "@std/path";
import { Builder } from "#ys-j/zipjs/zip";

const BundleTarget = {
	Chrome: "chrome",
	Firefox: "firefox",
} as const;
type BundleTarget = typeof BundleTarget[keyof typeof BundleTarget];

await Deno.remove("dist/", { recursive: true }).catch(error => {
	if (!(error instanceof Deno.errors.NotFound)) throw error;
});
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
		const vendor = `dist/${target}/vendor`;
		await Deno.mkdir(vendor);
		const dependency = new URL('./', import.meta.resolve('@huggingface/transformers'));
		for (const name of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
			await Deno.copyFile(new URL(name, dependency), `${vendor}/${name}`);
		}
		await Deno.copyFile(new URL('../LICENSE', dependency), `${vendor}/transformers.LICENSE`);
		// The ONNX Runtime npm package does not include its license.
		await Deno.copyFile('licenses/onnxruntime.LICENSE', `${vendor}/onnxruntime.LICENSE`);
	}
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
