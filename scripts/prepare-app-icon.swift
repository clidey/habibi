import AppKit

// Compose the supplied artwork without changing its proportions or clipping it.
guard CommandLine.arguments.count == 3,
      let artwork = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Usage: prepare-app-icon.swift <logo.png> <output.png>\n", stderr)
  exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
NSColor(calibratedRed: 0.082, green: 0.137, blue: 0.247, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 208, yRadius: 208).fill()
let scale = min(800 / artwork.size.width, 800 / artwork.size.height)
let size = NSSize(width: artwork.size.width * scale, height: artwork.size.height * scale)
artwork.draw(in: NSRect(x: (1024 - size.width) / 2, y: (1024 - size.height) / 2, width: size.width, height: size.height),
             from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
do { try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2])) }
catch { fputs("Could not write app icon\n", stderr); exit(1) }
