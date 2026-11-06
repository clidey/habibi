import AppKit
import PDFKit
import Vision
import ImageIO

// Standalone, bounded local converter. The service validates selected-path access
// and approvals; this helper never accepts shell commands or contacts a provider.
@main struct HabibiFileTools {
  static func main() {
    do {
      let input = FileHandle.standardInput.readDataToEndOfFile()
      guard input.count <= 128_000, let request = try JSONSerialization.jsonObject(with: input) as? [String: Any], let action = request["action"] as? String else { throw Failure.invalid }
      var result: [String: Any] = ["ok": true]
      switch action {
      case "inspect":
        let file = try inputURL(request["path"])
        if file.pathExtension.lowercased() == "pdf" {
          guard let document = PDFDocument(url: file), !document.isLocked, document.pageCount <= 500 else { throw Failure.invalid }
          result["pages"] = document.pageCount
          result["text"] = (0..<min(document.pageCount, 12)).map { "Page \($0 + 1): " + String((document.page(at: $0)?.string ?? "[No extractable text]").prefix(1500)) }.joined(separator: "\n").prefix(12_000).description
        } else {
          let source = try image(file)
          let recognition = VNRecognizeTextRequest(); recognition.recognitionLevel = .accurate
          try VNImageRequestHandler(cgImage: source).perform([recognition])
          result["text"] = String((recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").prefix(12_000))
          result["width"] = source.width; result["height"] = source.height
        }
      case "image":
        guard let sources = request["sources"] as? [String], sources.count == 1 else { throw Failure.invalid }
        let source = try image(try inputURL(sources[0])); let output = try outputURL(request["destination"])
        let width = min(source.width, max(100, min(6000, request["width"] as? Int ?? source.width)))
        let height = max(1, Int(Double(source.height) * Double(width) / Double(source.width)))
        guard width * height <= 64_000_000, let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure.invalid }
        context.interpolationQuality = .high; context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { throw Failure.invalid }
        let bitmap = NSBitmapImageRep(cgImage: scaled); let png = output.pathExtension.lowercased() == "png"
        var quality = max(10, min(95, request["quality"] as? Int ?? 75)); let target = request["targetBytes"] as? Int
        var encoded: Data?
        repeat {
          encoded = bitmap.representation(using: png ? .png : .jpeg, properties: [.compressionFactor: Double(quality) / 100])
          if png || target == nil || (encoded?.count ?? Int.max) <= target! || quality <= 15 { break }
          quality -= 10
        } while quality >= 5
        guard let encoded else { throw Failure.invalid }; try encoded.write(to: output, options: .withoutOverwriting)
        result["bytes"] = encoded.count
      case "pdf":
        guard let sources = request["sources"] as? [String], !sources.isEmpty, sources.count <= 100 else { throw Failure.invalid }
        let output = try outputURL(request["destination"]); var documents: [String: PDFDocument] = [:]
        for source in sources { let url = try inputURL(source); guard url.pathExtension.lowercased() == "pdf", let document = PDFDocument(url: url), !document.isLocked, document.pageCount <= 500 else { throw Failure.invalid }; documents[source] = document }
        var selections = request["pages"] as? [[String: Any]] ?? []
        if selections.isEmpty { for source in sources { for page in 1...(documents[source]!.pageCount) { selections.append(["path": source, "page": page]) } } }
        guard !selections.isEmpty, selections.count <= 500 else { throw Failure.invalid }
        let combined = PDFDocument(); let quality = request["quality"] as? Int
        for selection in selections {
          guard let file = selection["path"] as? String, let number = selection["page"] as? Int, number > 0, let page = documents[file]?.page(at: number - 1)?.copy() as? PDFPage else { throw Failure.invalid }
          let rotation = selection["rotate"] as? Int ?? 0; guard [0,90,180,270,-90].contains(rotation) else { throw Failure.invalid }
          page.rotation = (page.rotation + rotation + 360) % 360
          if let quality {
            let rect = page.bounds(for: .mediaBox); guard rect.width > 0, rect.height > 0, rect.width < 4000, rect.height < 4000 else { throw Failure.invalid }
            let thumbnail = page.thumbnail(of: NSSize(width: rect.width * 1.67, height: rect.height * 1.67), for: .mediaBox)
            guard let tiff = thumbnail.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: Double(max(10,min(95,quality))) / 100]), let image = NSImage(data: jpeg), let raster = PDFPage(image: image) else { throw Failure.invalid }
            raster.setBounds(rect, for: .mediaBox); combined.insert(raster, at: combined.pageCount)
          } else { combined.insert(page, at: combined.pageCount) }
        }
        guard let data = combined.dataRepresentation(), data.count <= 200 * 1024 * 1024 else { throw Failure.invalid }
        try data.write(to: output, options: .withoutOverwriting); result["pages"] = combined.pageCount; result["bytes"] = data.count
      case "trash":
        let file = try inputURL(request["path"]); var resulting: NSURL?
        try FileManager.default.trashItem(at: file, resultingItemURL: &resulting)
        guard let resulting else { throw Failure.invalid }; result["path"] = resulting.path
      default: throw Failure.invalid
      }
      let data = try JSONSerialization.data(withJSONObject: result); FileHandle.standardOutput.write(data)
    } catch { FileHandle.standardOutput.write(Data("{\"ok\":false}".utf8)); exit(1) }
  }
  enum Failure: Error { case invalid }
  static func inputURL(_ value: Any?) throws -> URL {
    guard let value = value as? String, value.hasPrefix("/"), !value.contains("\0") else { throw Failure.invalid }
    let url = URL(fileURLWithPath: value); let properties = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard properties.isRegularFile == true, properties.isSymbolicLink != true, (properties.fileSize ?? Int.max) <= 200 * 1024 * 1024 else { throw Failure.invalid }; return url
  }
  static func outputURL(_ value: Any?) throws -> URL {
    guard let value = value as? String, value.hasPrefix("/"), !FileManager.default.fileExists(atPath: value) else { throw Failure.invalid }; return URL(fileURLWithPath: value)
  }
  static func image(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0, width * height <= 64_000_000, let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.invalid }; return image
  }
}
