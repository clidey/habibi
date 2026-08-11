import AppKit
import WebKit

/// Render a local page through WebKit at a precise viewport. This is also the
/// engine used by Habibi's native panel, so the README captures real UI styles.
final class SnapshotDelegate: NSObject, WKNavigationDelegate {
  let source: URL
  let output: URL
  let size: NSSize
  private var webView: WKWebView?

  init(source: URL, output: URL, size: NSSize) {
    self.source = source
    self.output = output
    self.size = size
  }

  func start() {
    let view = WKWebView(frame: NSRect(origin: .zero, size: size))
    view.navigationDelegate = self
    webView = view
    if source.isFileURL {
      view.loadFileURL(source, allowingReadAccessTo: source.deletingLastPathComponent())
    } else {
      view.load(URLRequest(url: source))
    }
  }

  func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak webView] in
      guard let self, let webView else { return }
      let config = WKSnapshotConfiguration()
      config.rect = NSRect(origin: .zero, size: self.size)
      config.snapshotWidth = NSNumber(value: Double(self.size.width))
      webView.takeSnapshot(with: config) { image, error in
        guard error == nil, let image else {
          fputs("Could not render SVG screenshot\n", stderr)
          NSApp.terminate(nil)
          return
        }
        // WebKit snapshots carry transparent pixels around its host scrollbar.
        // Flatten into Habibi's dark capture background so image viewers and
        // GitHub never substitute white bars for that transparent gutter.
        guard let bitmap = NSBitmapImageRep(
          bitmapDataPlanes: nil,
          pixelsWide: Int(image.size.width),
          pixelsHigh: Int(image.size.height),
          bitsPerSample: 8,
          samplesPerPixel: 4,
          hasAlpha: true,
          isPlanar: false,
          colorSpaceName: .deviceRGB,
          bytesPerRow: 0,
          bitsPerPixel: 32
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
          fputs("Could not prepare opaque PNG canvas\n", stderr)
          NSApp.terminate(nil)
          return
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor(red: 0.024, green: 0.09, blue: 0.15, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(origin: .zero, size: image.size)).fill()
        image.draw(in: NSRect(origin: .zero, size: image.size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
          fputs("Could not encode PNG screenshot\n", stderr)
          NSApp.terminate(nil)
          return
        }
        do { try png.write(to: self.output) }
        catch { fputs("Could not write screenshot: \(error)\n", stderr) }
        NSApp.terminate(nil)
      }
    }
  }

  func webView(_: WKWebView, didFail _: WKNavigation!, withError error: Error) {
    fputs("Could not load SVG: \(error.localizedDescription)\n", stderr)
    NSApp.terminate(nil)
  }
}

guard CommandLine.arguments.count == 5,
      let width = Double(CommandLine.arguments[3]),
      let height = Double(CommandLine.arguments[4]) else {
  fputs("Usage: render-svg <page-url-or-file> <output.png> <width> <height>\n", stderr)
  exit(64)
}

let delegate = SnapshotDelegate(
  source: URL(string: CommandLine.arguments[1]) ?? URL(fileURLWithPath: CommandLine.arguments[1]),
  output: URL(fileURLWithPath: CommandLine.arguments[2]),
  size: NSSize(width: width, height: height)
)
NSApplication.shared.setActivationPolicy(.prohibited)
delegate.start()
NSApplication.shared.run()
