import AppKit
import PDFKit
import Foundation
@main struct FileToolsFixtures {
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1]); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    for (filename, label) in [("report-a.pdf", "Demo Cafe\nInvoice 2026-11-06\nTotal GBP 12.50"), ("report-b.pdf", "Demo Studio\nInvoice 2026-11-05\nTotal GBP 40.00")] {
      let data = NSMutableData(); guard let consumer = CGDataConsumer(data: data) else { fatalError() }
      var rect = CGRect(x: 0, y: 0, width: 600, height: 800); guard let context = CGContext(consumer: consumer, mediaBox: &rect, nil) else { fatalError() }
      for page in 1...3 { context.beginPDFPage(nil); NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false); (label + "\nPage \(page)").draw(at: NSPoint(x: 40, y: 700), withAttributes: [.font: NSFont.systemFont(ofSize: 20)]); NSGraphicsContext.restoreGraphicsState(); context.endPDFPage() }
      context.closePDF(); try (data as Data).write(to: root.appendingPathComponent(filename))
    }
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1800, pixelsHigh: 1200, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError() }
    for y in 0..<1200 { for x in 0..<1800 { bitmap.setColor(NSColor(calibratedRed: CGFloat((x*37+y*19)%256)/255, green: CGFloat((x*11+y*43)%256)/255, blue: CGFloat((x*5+y*7)%256)/255, alpha: 1), atX: x, y: y) } }
    try bitmap.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("photo.png"))
    print("Created fictional PDF and image fixtures.")
  }
}
