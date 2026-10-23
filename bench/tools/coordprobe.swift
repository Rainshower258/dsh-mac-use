import AppKit
import CoreGraphics
// Opens a window at a known frame, paints a red 10x10pt marker at a known
// content offset, captures it exactly like CUADaemon's Screenshot.swift,
// then locates the marker in the PNG to derive pixel -> global point mapping.
class MarkerView: NSView {
  override var isFlipped: Bool { true }  // top-left origin like CGEvent
  override func draw(_ r: NSRect) {
    NSColor.white.setFill(); bounds.fill()
    NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1).setFill()
    NSRect(x: 100, y: 50, width: 10, height: 10).fill()
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let win = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
win.contentView = MarkerView()
let label = NSTextField(labelWithString: "probe-label A7x-9K2q")
label.frame = NSRect(x: 150, y: 120, width: 200, height: 20)
win.contentView!.addSubview(label)
win.title = "coordprobe"
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "hold" {
  DispatchQueue.main.asyncAfter(deadline: .now() + 12.0) { exit(0) }
} else {
DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
  let wid = CGWindowID(win.windowNumber)
  let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as! [[String: Any]])[0]
  let b = info[kCGWindowBounds as String] as! [String: CGFloat]
  let img = CGWindowListCreateImage(.null, [.optionIncludingWindow], wid, [.bestResolution, .boundsIgnoreFraming])!
  print("kCGWindowBounds(pt, global top-left) = x\(b["X"]!) y\(b["Y"]!) w\(b["Width"]!) h\(b["Height"]!)")
  print("image px = \(img.width)x\(img.height)  ratio w=\(Double(img.width)/Double(b["Width"]!)) h=\(Double(img.height)/Double(b["Height"]!))")
  let rep = NSBitmapImageRep(cgImage: img)
  var found: (Int, Int)? = nil
  outer: for y in 0..<img.height { for x in 0..<img.width {
    let c = rep.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
    if c.redComponent > 0.8 && c.greenComponent < 0.35 && c.blueComponent < 0.35 { found = (x, y); break outer }
  }}
  // Marker top-left in global points: content origin + (100,50).
  let contentTopLeftGlobalY = NSScreen.screens[0].frame.height - (win.frame.origin.y + win.contentLayoutRect.maxY)
  let contentTopLeftGlobalX = win.frame.origin.x + win.contentLayoutRect.minX
  let markerPt = (contentTopLeftGlobalX + 100, contentTopLeftGlobalY + 50)
  print("marker expected global pt = \(markerPt)")
  for (x,y) in [(200,164),(205,169),(10,10),(400,300)] { print("px(\(x),\(y)) = \(rep.colorAt(x: x, y: y)!)") }
  print("marker found in image px = \(String(describing: found))")
  if let f = found {
    let s = Double(img.width) / Double(b["Width"]!)
    print("mapped back: x = winX + px/s = \(Double(b["X"]!) + Double(f.0)/s), y = winY + py/s = \(Double(b["Y"]!) + Double(f.1)/s)")
  }
  // AX view of the same window, as CUADaemon's AX tree would report it.
  let axApp = AXUIElementCreateApplication(getpid())
  var wins: CFTypeRef?; AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &wins)
  if let w = (wins as? [AXUIElement])?.first {
    var pos: CFTypeRef?; AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pos)
    var p = CGPoint.zero; AXValueGetValue(pos as! AXValue, .cgPoint, &p)
    print("AX window position (pt) = \(p)")
  }
  exit(0)
}
}
app.run()
