import AppKit
import ImageIO
import UniformTypeIdentifiers

/** Bounded image decoding shared by explicit paste and opt-in clipboard history. */
enum ClipboardImages {
  static let maximumBytes = 8 * 1024 * 1024
  static let maximumInputBytes = 128 * 1024 * 1024
  static func png(from board: NSPasteboard) -> Data? {
    let advertised = board.types ?? []
    let preferred: [NSPasteboard.PasteboardType] = [.png, .tiff, .init("public.jpeg"), .init("public.heic"), .init("public.heif"), .init("org.webmproject.webp"), .init("com.compuserve.gif"), .init("com.microsoft.bmp")]
    let extra = advertised.filter { type in !preferred.contains(type) && UTType(type.rawValue)?.conforms(to: .image) == true }
    for type in preferred + extra where advertised.contains(type) {
      if let data = board.data(forType: type), let result = png(data) { return result }
    }
    return nil
  }
  static func png(_ data: Data) -> Data? {
    guard data.count <= maximumInputBytes, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 64_000_000 else { return nil }
    if CGImageSourceGetType(source) == UTType.png.identifier as CFString { return data.count <= maximumBytes ? data : nil }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
          let result = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), result.count <= maximumBytes else { return nil }
    return result
  }
  static func thumbnail(_ data: Data) -> Data? {
    guard data.count <= maximumInputBytes, let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 160, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
  }
  static func storePaste(_ data: Data) -> URL? {
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Habibi/.habibi/paste-images", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let url = root.appendingPathComponent("\(UUID().uuidString).png")
      try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey])) ?? []
      let ordered = files.filter { $0.pathExtension == "png" }.sorted { ((try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) }
      for old in ordered.dropFirst(20) { try? FileManager.default.removeItem(at: old) }
      return url
    } catch { return nil }
  }
}
