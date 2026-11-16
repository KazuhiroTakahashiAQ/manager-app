// Swift のヘルパー（native/*.swift）を userData/bin にコンパイルする。元が変わったときだけ作り直す。
// 元はバンドルに文字列として同梱する（配布版でも元のファイルを探さずに済む）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const building = new Map<string, Promise<string | null>>();
const built = new Map<string, string>();

export function ensureNative(name: string, source: string, dataDir: string): Promise<string | null> {
	const ok = built.get(name);
	if (ok) return Promise.resolve(ok);
	let p = building.get(name);
	if (!p) {
		p = compile(name, source, dataDir)
			.then((bin) => {
				if (bin) built.set(name, bin);
				return bin;
			})
			.finally(() => building.delete(name));
		building.set(name, p);
	}
	return p;
}

async function compile(name: string, source: string, dataDir: string): Promise<string | null> {
	const dir = join(dataDir, "bin");
	const bin = join(dir, name);
	const hashFile = `${bin}.hash`;
	const hash = String(Bun.hash(source));
	try {
		if (existsSync(bin) && readFileSync(hashFile, "utf-8") === hash) return bin;
	} catch {
		// 作り直す
	}
	const swiftc = "/usr/bin/swiftc";
	if (!existsSync(swiftc)) {
		console.error(`swiftc がないので ${name} を作れない（xcode-select --install で入る）`);
		return null;
	}
	mkdirSync(dir, { recursive: true });
	const src = join(dir, `${name}.swift`);
	writeFileSync(src, source);
	const p = Bun.spawn([swiftc, "-O", "-o", bin, src], { stdout: "pipe", stderr: "pipe" });
	const code = await p.exited;
	if (code !== 0 || !existsSync(bin)) {
		console.error(`${name} をコンパイルできなかった`, (await new Response(p.stderr).text()).slice(0, 500));
		return null;
	}
	writeFileSync(hashFile, hash);
	return bin;
}
