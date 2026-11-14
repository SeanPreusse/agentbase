import AppKit
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())
let destination = arguments.first(where: { !$0.hasPrefix("--") }) ?? "assets/logo.png"
let circular = arguments.contains("--circle")
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                            isPlanar: false, colorSpaceName: .deviceRGB,
                            bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}
func shape(_ points: [NSPoint]) -> NSBezierPath {
    let path = NSBezierPath()
    path.move(to: points[0])
    for point in points.dropFirst() { path.line(to: point) }
    path.close()
    return path
}
let background = circular
    ? NSBezierPath(ovalIn: NSRect(x: 24, y: 24, width: size - 48, height: size - 48))
    : NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: 224, yRadius: 224)
NSGradient(starting: color(12, 23, 38), ending: color(20, 43, 53))!.draw(in: background, angle: -45)

// Two folded ribbons form one sharp summit with an open base.
let left = shape([
    NSPoint(x: 190, y: 270), NSPoint(x: 512, y: 795),
    NSPoint(x: 512, y: 610), NSPoint(x: 313, y: 270)
])
NSGradient(starting: color(137, 219, 208), ending: color(225, 247, 240))!.draw(in: left, angle: 110)
let right = shape([
    NSPoint(x: 512, y: 795), NSPoint(x: 834, y: 270),
    NSPoint(x: 711, y: 270), NSPoint(x: 512, y: 610)
])
NSGradient(starting: color(43, 145, 154), ending: color(34, 105, 127))!.draw(in: right, angle: 40)

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
let data = bitmap.representation(using: .png, properties: [:])!
try data.write(to: URL(fileURLWithPath: destination))
