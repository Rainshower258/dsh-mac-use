// Keyboard input source control for VM experiments (bench/experiments/ime.py).
//   inputsource current            the selected keyboard input source's ID
//   inputsource list               enabled + enableable input sources (ID, selectable)
//   inputsource select ID          enable (if needed) and select ID; prints the selected ID afterwards
// Build: swiftc -O -target arm64-apple-macosx14.0 bench/tools/inputsource.swift -o bench/tools/bin/inputsource
import Carbon
import Foundation

func prop(_ s: TISInputSource, _ key: CFString) -> String? {
    guard let p = TISGetInputSourceProperty(s, key) else { return nil }
    return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
}

func sources(includeAll: Bool) -> [TISInputSource] {
    (TISCreateInputSourceList(nil, includeAll)?.takeRetainedValue() as? [TISInputSource]) ?? []
}

func current() -> String {
    prop(TISCopyCurrentKeyboardInputSource().takeRetainedValue(), kTISPropertyInputSourceID) ?? "?"
}

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "current":
    print(current())
case "list":
    for s in sources(includeAll: true) {
        guard let id = prop(s, kTISPropertyInputSourceID) else { continue }
        print(id)
    }
case "select":
    guard let want = args.dropFirst().first else { fputs("select needs an ID\n", stderr); exit(2) }
    guard let s = sources(includeAll: true).first(where: { prop($0, kTISPropertyInputSourceID) == want }) else {
        fputs("no input source \(want)\n", stderr); exit(1)
    }
    TISEnableInputSource(s)
    let rc = TISSelectInputSource(s)
    usleep(300_000)
    print(current())
    exit(rc == noErr ? 0 : 1)
default:
    fputs("usage: inputsource current|list|select ID\n", stderr)
    exit(2)
}
