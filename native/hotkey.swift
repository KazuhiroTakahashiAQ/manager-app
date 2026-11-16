// 常駐して Ctrl の 2 連打（Ctrl だけを 2 回、300ms 以内）を見張り、見つけたら "summon" を 1 行出す。
// ほかのアプリが前面でも効くよう、NSEvent のグローバル監視（flagsChanged・keyDown）を使う。
// 出力: 起動時に "ready"、アクセシビリティの権限がなければ "permission"（権限が付くまで待ち、付いたら "ready"）。
// 親（manager-app）が終わったら stdin が閉じるので、それを見て抜ける。
// ビルド: /usr/bin/swiftc -O -o hotkey hotkey.swift

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let tapMax: TimeInterval = 0.3 // 1 回の押し下げの長さ
let gapMax: TimeInterval = 0.3 // 1 回目を離してから 2 回目を離すまで

var downAt: TimeInterval = 0
var ctrlAlone = false
var lastTap: TimeInterval = 0

func say(_ s: String) {
	print(s)
	fflush(stdout)
}

func onFlags(_ e: NSEvent) {
	let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
	let now = e.timestamp
	if flags == [.control] {
		// Ctrl だけが押された
		downAt = now
		ctrlAlone = true
	} else if flags.isEmpty {
		// 離した
		if ctrlAlone && now - downAt <= tapMax {
			if lastTap > 0 && now - lastTap <= gapMax + tapMax {
				say("summon")
				lastTap = 0
			} else {
				lastTap = now
			}
		} else {
			lastTap = 0
		}
		ctrlAlone = false
	} else {
		// ほかの修飾キーと一緒
		ctrlAlone = false
		lastTap = 0
	}
}

func onKey(_ e: NSEvent) {
	ctrlAlone = false
	lastTap = 0
}

// stdin が閉じたら（親が終わったら）抜ける
DispatchQueue.global().async {
	while let _ = readLine(strippingNewline: true) {}
	exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

var monitors: [Any] = []
func install() {
	if let m = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: onFlags) { monitors.append(m) }
	if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: onKey) { monitors.append(m) }
	say("ready")
}

if AXIsProcessTrusted() {
	install()
} else {
	say("permission")
	// 権限が付くまで 5 秒ごとに確かめる
	Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { t in
		if AXIsProcessTrusted() {
			t.invalidate()
			install()
		}
	}
}

app.run()
