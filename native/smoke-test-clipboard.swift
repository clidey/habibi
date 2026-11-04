import AppKit
import Foundation

final class ClipboardTestDefaults: UserDefaults {
  private var enabled = false
  override func bool(forKey name: String) -> Bool { enabled }
  override func set(_ value: Any?, forKey name: String) { enabled = value as? Bool ?? false }
}

@main struct ClipboardImageSmokeTest {
  static func bitmap(_ width: Int, _ height: Int) -> NSBitmapImageRep {
    let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 3, bitsPerPixel: 24)!
    memset(image.bitmapData!, 180, image.bytesPerRow * height)
    return image
  }
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("habibi-clipboard-smoke-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let image = bitmap(6000, 2)
    let png = image.representation(using: .png, properties: [:])!
    let jpeg = image.representation(using: .jpeg, properties: [:])!
    let tiff = bitmap(2000, 2000).representation(using: .tiff, properties: [:])!
    assert(tiff.count > ClipboardImages.maximumBytes)
    assert(ClipboardImages.png(tiff) != nil, "uncompressed screenshots must be converted before enforcing the PNG size limit")
    for (type, data) in [(NSPasteboard.PasteboardType.png, png), (.init("public.jpeg"), jpeg), (.tiff, tiff)] {
      board.clearContents(); board.setData(data, forType: type)
      assert(ClipboardImages.png(from: board) != nil, "PNG, JPEG and large TIFF must be readable")
    }
    assert(ClipboardImages.png(Data("not an image".utf8)) == nil)
    let history = ClipboardHistory(root: root, board: board, defaults: ClipboardTestDefaults(), monitor: false)
    history.setEnabled(true)
    var entries = history.snapshot()["items"] as! [[String: Any]]
    assert(entries.count == 1 && entries[0]["kind"] as? String == "image", "enabling captures the item already copied")
    let preview = entries[0]["previewPath"] as! String
    let thumbnail = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: preview)))!
    assert(thumbnail.pixelsWide <= 160 && thumbnail.pixelsHigh <= 160)
    let file = root.appendingPathComponent("Photo.png"); try png.write(to: file)
    board.clearContents(); board.writeObjects([file as NSURL])
    entries = history.snapshot()["items"] as! [[String: Any]]
    assert(entries.count == 2 && entries[0]["kind"] as? String == "file")
    assert(!(entries[0]["previewPath"] as! String).isEmpty, "copied image files need thumbnails")
    board.clearContents(); board.setData(jpeg, forType: .init("public.jpeg"))
    entries = history.snapshot()["items"] as! [[String: Any]]
    assert(entries.count == 3 && entries[0]["kind"] as? String == "image")
    board.clearContents(); board.setData(png, forType: .png); board.setString("private", forType: .init("org.nspasteboard.ConcealedType"))
    assert((history.snapshot()["items"] as! [[String: Any]]).count == 3)
    history.setEnabled(false); board.clearContents(); board.setData(png, forType: .png)
    assert((history.snapshot()["items"] as! [[String: Any]]).count == 3)
    print("Clipboard image checks passed: PNG, JPEG, large TIFF, existing-copy capture, private thumbnails, file URLs, concealed types, and pause.")
  }
}
