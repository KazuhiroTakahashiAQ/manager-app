// @hutch cli=0.29.0 cottontail=0.7.3
export default {
	// 依存の管理は pnpm（bun のバージョンも package.json の devDependencies で固定する）
	packageManager: "pnpm",
	scripts: {
		install: ["pnpm", "install", "--frozen-lockfile"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
		"build:canary": ["hutch", "electrobun", "build", "--env=canary"],
	},
	electrobun: {
		version: "2.0.6",
	},
};
