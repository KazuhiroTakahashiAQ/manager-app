import { expect, test } from "bun:test";
import { childLabel, clampNameW, NAME_W_DEFAULT, NAME_W_MAX, NAME_W_MIN, parseNameW } from "./wbs-name";

test("子の接頭辞（親名_）を取る", () => {
	expect(childLabel("ウェビナー開催_リハーサル", "ウェビナー開催")).toBe("リハーサル");
	expect(childLabel("ダイダン_機能2要件定義", "ダイダン")).toBe("機能2要件定義");
	expect(childLabel("親 / 子", "親")).toBe("子");
});
test("接頭辞でなければそのまま", () => {
	expect(childLabel("別の作業", "親")).toBe("別の作業");
	expect(childLabel("親名拡張", "親名")).toBe("親名拡張");
	expect(childLabel("x", "")).toBe("x");
});
test("取って空になるなら元のまま", () => {
	expect(childLabel("親_", "親")).toBe("親_");
	expect(childLabel("親", "親")).toBe("親");
});
test("幅の保存値を復元・丸める", () => {
	expect(parseNameW(null)).toBe(NAME_W_DEFAULT);
	expect(parseNameW("abc")).toBe(NAME_W_DEFAULT);
	expect(parseNameW("500")).toBe(500);
	expect(parseNameW("10")).toBe(NAME_W_MIN);
	expect(parseNameW("5000")).toBe(NAME_W_MAX);
	expect(clampNameW(300.4)).toBe(300);
});
