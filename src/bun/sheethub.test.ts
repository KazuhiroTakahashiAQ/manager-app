import { describe, expect, test } from "bun:test";
import { ensureHub, hubState, pingHub, serveScriptPath, type FetchLike, type HubDeps, type PingResult } from "./sheethub";

const deps = (ping: PingResult, exists = true) => {
	const spawned: string[] = [];
	const d: HubDeps = { ping: async () => ping, scriptExists: () => exists, spawn: (s) => void spawned.push(s), script: "/x/serve.ts" };
	return { d, spawned };
};

describe("pingHub", () => {
	test("app が sheet-preview なら hub", async () => {
		const f: FetchLike = async () => ({ json: async () => ({ app: "sheet-preview" }) });
		expect(await pingHub(f)).toBe("hub");
	});
	test("別の app / JSON でない応答は foreign", async () => {
		expect(await pingHub(async () => ({ json: async () => ({ app: "x" }) }))).toBe("foreign");
		expect(await pingHub(async () => ({ json: async () => { throw new Error("not json"); } }))).toBe("foreign");
	});
	test("接続拒否は down", async () => {
		expect(await pingHub(async () => { throw new Error("ECONNREFUSED"); })).toBe("down");
	});
	test("タイムアウトは down", async () => {
		const f: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort"))));
		expect(await pingHub(f, 20)).toBe("down");
	});
});

describe("ensureHub", () => {
	test("生きていれば起動しない", async () => {
		const { d, spawned } = deps("hub");
		expect(await ensureHub(d)).toBe("running");
		expect(spawned).toEqual([]);
	});
	test("応答なしなら serve.ts を起動する", async () => {
		const { d, spawned } = deps("down");
		expect(await ensureHub(d)).toBe("started");
		expect(spawned).toEqual(["/x/serve.ts"]);
	});
	test("別プロセスが使用中なら起動しない", async () => {
		const { d, spawned } = deps("foreign");
		expect(await ensureHub(d)).toBe("foreign");
		expect(spawned).toEqual([]);
	});
	test("serve.ts が無ければ起動しない", async () => {
		const { d, spawned } = deps("down", false);
		expect(await ensureHub(d)).toBe("no-script");
		expect(spawned).toEqual([]);
	});
	test("spawn が投げても落ちない", async () => {
		const { d } = deps("down");
		d.spawn = () => { throw new Error("boom"); };
		expect(await ensureHub(d)).toBe("failed");
	});
});

describe("hubState / path", () => {
	test("状態", async () => {
		expect(await hubState(deps("hub").d)).toBe("running");
		expect(await hubState(deps("foreign").d)).toBe("foreign");
		expect(await hubState(deps("down").d)).toBe("down");
		expect(await hubState(deps("down", false).d)).toBe("no-script");
	});
	test("serve.ts のパスは home から展開", () => {
		expect(serveScriptPath("/h")).toBe("/h/.claude/skills/sheet-preview/scripts/serve.ts");
	});
});
