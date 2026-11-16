// ドラッグ用のペーストボード（NSPasteboard.drag）にあるファイルの絶対パスを、JSON の文字列配列で 1 行出して抜ける。
// WKWebView はドロップされたファイルのローカルパスをページに渡さないので、Finder などがドラッグに載せた
// ファイル URL をここから読む（drop の直後に呼ぶ。中身は次のドラッグまで残る）。
// Finder はファイル参照 URL（file:///.file/id=...）を載せることがあるので、パスの URL に直して出す。
// ビルド: /usr/bin/swiftc -O -o drag-paths drag-paths.swift

import AppKit
import Foundation

let pb = NSPasteboard(name: .drag)
let objs = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []
var paths: [String] = []
for o in objs {
	guard let u = o as? NSURL else { continue }
	let fileURL = (u.filePathURL ?? (u as URL)) as URL
	let p = fileURL.path
	if !p.isEmpty { paths.append(p) }
}
let data = (try? JSONSerialization.data(withJSONObject: paths)) ?? Data("[]".utf8)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
