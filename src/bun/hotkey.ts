// Ctrl の 2 連打で Clawd くんを呼ぶ。Swift の常駐ヘルパー（native/hotkey.swift）を立ち上げ、"summon" の行を受ける。
// ほかのアプリが前面でも効く（NSEvent のグローバル監視。アクセシビリティの権限が要る）。

import { ensureNative } from "./native";
import hotkeySource from "../../native/hotkey.swift" with { type: "text" };

type HotkeyOptions = {
	dataDir: string;
	summon: () => void;
	/** 権限がない（1 回だけ案内する） */
	permissionNeeded: () => void;
};

export class Hotkey {
	private proc: { kill(): void } | null = null;
	private disposed = false;
	private warned = false;
	private restarts = 0;

	constructor(private o: HotkeyOptions) {
		void this.start();
	}

	dispose() {
		this.disposed = true;
		this.proc?.kill();
	}

	private async start() {
		const bin = await ensureNative("hotkey", hotkeySource, this.o.dataDir);
		if (!bin || this.disposed) return;
		// stdin をつないでおく（親が終わると閉じ、ヘルパーも抜ける）
		const p = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
		this.proc = p;
		void (async () => {
			const reader = p.stdout.getReader();
			const dec = new TextDecoder();
			let buf = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, i).trim();
						buf = buf.slice(i + 1);
						if (line === "summon") this.o.summon();
						else if (line === "permission" && !this.warned) {
							this.warned = true;
							this.o.permissionNeeded();
						}
					}
				}
			} catch {
				// 終了
			}
		})();
		p.exited.then(() => {
			this.proc = null;
			if (!this.disposed && ++this.restarts <= 5) setTimeout(() => void this.start(), 10_000);
		});
	}
}
