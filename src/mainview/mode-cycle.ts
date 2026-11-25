// dock の表示（Claude / Shell / File）。⌘J で Claude → Shell → File → Claude と循環する。

export type Mode = "claude" | "shell" | "file";

export function nextMode(current: Mode): Mode {
	return current === "claude" ? "shell" : current === "shell" ? "file" : "claude";
}
