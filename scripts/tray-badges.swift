// macOS renders tray templates at 18 pt, so export exactly 2x (48×36 px).
import AppKit
let icons = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("apps/desktop/src-tauri/icons")
for state in ["default", "synced", "paused", "alert", "syncing"] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 48, pixelsHigh: 36,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.black.withAlphaComponent(state == "paused" ? 0.45 : 1).setFill()
    let arch = NSBezierPath()
    arch.move(to: NSPoint(x: 4, y: 3))
    arch.line(to: NSPoint(x: 4, y: 18))
    arch.appendArc(withCenter: NSPoint(x: 17, y: 18), radius: 13, startAngle: 180, endAngle: 0, clockwise: true)
    arch.line(to: NSPoint(x: 30, y: 3))
    arch.line(to: NSPoint(x: 23.7, y: 3))
    arch.line(to: NSPoint(x: 23.7, y: 18))
    arch.appendArc(withCenter: NSPoint(x: 17, y: 18), radius: 6.7, startAngle: 0, endAngle: 180)
    arch.line(to: NSPoint(x: 10.3, y: 3))
    arch.close(); arch.fill()
    NSBezierPath(roundedRect: NSRect(x: 13.5, y: 3, width: 7, height: 10), xRadius: 0.8, yRadius: 0.8).fill()
    if state != "default" {
        NSGraphicsContext.current!.compositingOperation = .copy
        NSColor.clear.setFill()
        NSBezierPath(ovalIn: NSRect(x: 24, y: 13, width: 24, height: 24)).fill()
        NSGraphicsContext.current!.compositingOperation = .sourceOver
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: 26, y: 15, width: 20, height: 20)).fill()
        NSGraphicsContext.current!.compositingOperation = .copy
        NSColor.clear.setStroke()
        let mark = NSBezierPath()
        mark.lineWidth = 2
        mark.lineCapStyle = .round; mark.lineJoinStyle = .round
        switch state {
        case "synced":
            mark.move(to: NSPoint(x: 31, y: 25)); mark.line(to: NSPoint(x: 34.5, y: 21.5)); mark.line(to: NSPoint(x: 41, y: 29))
        case "paused":
            for x in [33.5, 38.5] { mark.move(to: NSPoint(x: x, y: 21)); mark.line(to: NSPoint(x: x, y: 29)) }
        case "alert":
            mark.lineWidth = 2.5
            mark.move(to: NSPoint(x: 36, y: 29)); mark.line(to: NSPoint(x: 36, y: 24))
            mark.move(to: NSPoint(x: 36, y: 20.5)); mark.line(to: NSPoint(x: 36, y: 20.6))
        default:
            mark.lineWidth = 1.8
            mark.appendArc(withCenter: NSPoint(x: 36, y: 25), radius: 5.5, startAngle: 35, endAngle: 170)
            mark.move(to: NSPoint(x: 30.5, y: 29)); mark.line(to: NSPoint(x: 30.5, y: 26)); mark.line(to: NSPoint(x: 33.5, y: 26))
            mark.move(to: NSPoint(x: 31.5, y: 21.85))
            mark.appendArc(withCenter: NSPoint(x: 36, y: 25), radius: 5.5, startAngle: 215, endAngle: 350)
            mark.move(to: NSPoint(x: 41.5, y: 21)); mark.line(to: NSPoint(x: 41.5, y: 24)); mark.line(to: NSPoint(x: 38.5, y: 24))
        }
        mark.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    let file = state == "default" ? "tray.png" : "tray-\(state).png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: icons.appendingPathComponent(file))
}
