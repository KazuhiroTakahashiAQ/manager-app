import { describe, expect, test } from "bun:test";
import { FIXED_HUE, SLOT_COUNT, SLOT_HUES, assignSlots, fixedColor, slotColor } from "./tab-color";

const dist = (a: number, b: number) => {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `tasks/ダイダン_${i}.md`);

describe("tab-color", () => {
	test("12 色で、色相どうしも固定タブとも 24 度以上離れる", () => {
		expect(SLOT_COUNT).toBe(12);
		const all = [...SLOT_HUES, ...Object.values(FIXED_HUE)];
		for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(dist(all[i]!, all[j]!)).toBeGreaterThanOrEqual(24);
	});
	test("同時に開いたタブ（12 個まで）で色が重複しない", () => {
		const a = assignSlots(ids(12));
		expect(new Set(Object.values(a)).size).toBe(12);
	});
	test("13 個目以降は重なるが、使用数が偏らない", () => {
		const a = assignSlots(ids(24));
		const counts = new Map<number, number>();
		for (const s of Object.values(a)) counts.set(s, (counts.get(s) ?? 0) + 1);
		expect([...counts.values()].every((c) => c === 2)).toBe(true);
	});
	test("決定的。saved を渡せば再起動後も同じ、タブを足しても既存の色は変わらない", () => {
		const first = assignSlots(ids(5));
		expect(assignSlots(ids(5))).toEqual(first);
		const more = assignSlots([...ids(5), "tasks/new.md"], first);
		for (const id of ids(5)) expect(more[id]).toBe(first[id]!);
		expect(Object.values(more)).toHaveLength(6);
		expect(new Set(Object.values(more)).size).toBe(6);
	});
	test("タブを閉じた分のスロットは空き、saved が壊れていても割り当てられる", () => {
		const first = assignSlots(ids(3));
		const rest = assignSlots([ids(3)[0]!, ids(3)[2]!], first);
		expect(rest[ids(3)[0]!]).toBe(first[ids(3)[0]!]!);
		const bad = assignSlots(["a", "b"], { a: 99, b: -1 });
		expect(bad["a"]).toBeGreaterThanOrEqual(0);
		expect(bad["a"]).not.toBe(bad["b"]);
	});
	test("saved に同じスロットが重複していたら 2 つ目は振り直す", () => {
		const a = assignSlots(["a", "b"], { a: 3, b: 3 });
		expect(a["a"]).toBe(3);
		expect(a["b"]).not.toBe(3);
	});
	test("色は oklch で固定タブと sub mgr が同じ明度・彩度", () => {
		expect(fixedColor("main")).toBe("oklch(0.74 0.12 250)");
		expect(slotColor(0)).toMatch(/^oklch\(0\.74 0\.12 \d+\)$/);
	});
});
