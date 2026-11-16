// 前面アプリの前面ウィンドウの文字を Accessibility ツリーから拾い、JSON 1 行で出す。
// 出力: {"app","bundleId","title","texts"} / 権限がない: {"error":"permission"} / 画面ロック中: {"locked":true}
// - パスワード欄（AXSecureTextField）は中身も子も読まない。
// - 深さ・要素数・時間（約 3 秒）に上限を置き、文字は合計 4000 字まで。
// - Electron のアプリは AXManualAccessibility、Chrome 系は AXEnhancedUserInterface を立ててから読む。
// ビルド: /usr/bin/swiftc -O -o ax-snapshot ax-snapshot.swift

import AppKit
import ApplicationServices
import Foundation

let maxDepth = 40
let maxElements = 4000
let maxChars = 4000
let maxPerText = 400
let timeBudget: TimeInterval = 3.0

func emit(_ obj: [String: Any]) -> Never {
	if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
		let s = String(data: data, encoding: .utf8)
	{
		print(s)
	} else {
		print("{\"error\":\"encode\"}")
	}
	exit(0)
}

// 何かで固まっても 4.5 秒で抜ける
DispatchQueue.global().asyncAfter(deadline: .now() + 4.5) {
	emit(["error": "timeout"])
}

// 画面ロック中は読まない
if let dict = CGSessionCopyCurrentDictionary() as? [String: Any],
	let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked
{
	emit(["locked": true])
}

if !AXIsProcessTrusted() {
	emit(["error": "permission"])
}

guard let front = NSWorkspace.shared.frontmostApplication else {
	emit(["error": "nofront"])
}
let pid = front.processIdentifier
let appName = front.localizedName ?? ""
let bundleId = front.bundleIdentifier ?? ""
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.5)

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
	var v: CFTypeRef?
	return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
	guard let v = attr(el, name) else { return nil }
	if CFGetTypeID(v) == CFStringGetTypeID() { return v as? String }
	return nil
}

/// 立てた結果、値が変わったら true（初回は木ができるまで少し待つ）
func enable(_ name: String) -> Bool {
	if let v = attr(app, name), CFGetTypeID(v) == CFBooleanGetTypeID(), CFBooleanGetValue((v as! CFBoolean)) {
		return false
	}
	return AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue) == .success
}

func isElectron(_ app: NSRunningApplication) -> Bool {
	guard let url = app.bundleURL else { return false }
	let fw = url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
	return FileManager.default.fileExists(atPath: fw.path)
}

let chromeLike: Set<String> = [
	"com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.microsoft.edgemac",
	"com.brave.Browser", "com.vivaldi.Vivaldi", "company.thebrowser.Browser", "org.chromium.Chromium",
]
var changed = false
if isElectron(front) { changed = enable("AXManualAccessibility") || changed }
if chromeLike.contains(bundleId) { changed = enable("AXEnhancedUserInterface") || changed }
if changed { usleep(400_000) }

var window: AXUIElement?
for name in ["AXFocusedWindow", "AXMainWindow"] {
	if let v = attr(app, name), CFGetTypeID(v) == AXUIElementGetTypeID() {
		window = (v as! AXUIElement)
		break
	}
}
if window == nil, let ws = attr(app, "AXWindows") as? [AXUIElement], let first = ws.first {
	window = first
}
guard let win = window else {
	emit(["app": appName, "bundleId": bundleId, "title": "", "texts": ""])
}
let title = str(win, "AXTitle") ?? ""

let started = Date()
var texts: [String] = []
var total = 0
var visited = 0
var seen = Set<String>()

func add(_ raw: String?) {
	guard let raw = raw else { return }
	var t = raw.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
	if t.isEmpty || t == title || seen.contains(t) { return }
	if t.count > maxPerText { t = String(t.prefix(maxPerText)) + "…" }
	seen.insert(t)
	texts.append(t)
	total += t.count + 1
}

/// 深さ優先でたどる（画面の上から順に近い並び）
func walk(_ el: AXUIElement, _ depth: Int) {
	if depth > maxDepth || visited >= maxElements || total >= maxChars { return }
	if Date().timeIntervalSince(started) > timeBudget { return }
	visited += 1
	let role = str(el, "AXRole") ?? ""
	if role == "AXSecureTextField" { return }
	let sub = str(el, "AXSubrole") ?? ""
	if sub == "AXSecureTextField" { return }
	switch role {
	case "AXStaticText", "AXTextField", "AXTextArea", "AXHeading", "AXLink", "AXButton", "AXMenuButton", "AXCell", "AXTab",
		"AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXComboBox":
		add(str(el, "AXValue"))
		add(str(el, "AXTitle"))
		add(str(el, "AXDescription"))
	case "AXImage":
		add(str(el, "AXDescription"))
	default:
		add(str(el, "AXTitle"))
	}
	guard let kids = attr(el, "AXChildren") as? [AXUIElement] else { return }
	for k in kids {
		if visited >= maxElements || total >= maxChars { break }
		walk(k, depth + 1)
	}
}

walk(win, 0)

var joined = texts.joined(separator: "\n")
if joined.count > maxChars { joined = String(joined.prefix(maxChars)) }
emit(["app": appName, "bundleId": bundleId, "title": title, "texts": joined])
