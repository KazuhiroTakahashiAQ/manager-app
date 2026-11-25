import { expect, test } from "bun:test";
import { nextMode } from "./mode-cycle";

test("Claude → Shell → File → Claude", () => {
	expect(nextMode("claude")).toBe("shell");
	expect(nextMode("shell")).toBe("file");
	expect(nextMode("file")).toBe("claude");
});
