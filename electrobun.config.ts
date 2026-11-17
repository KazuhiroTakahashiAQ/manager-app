import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "manager",
		identifier: "jp.asia-quest.kazuhiro.manager",
		version: "0.1.0",
	},
	build: {
		mainProcess: "bun",
		// `dev --watch` を使うときも、画面側の変更ではアプリを作り直さない（src/bun/dev-reload.ts が WebView だけ読み込み直す）
		watchIgnore: ["src/mainview/**"],
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"node_modules/@xterm/xterm/css/xterm.css": "views/mainview/xterm.css",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
