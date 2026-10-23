// Standalone Apple Vision OCR for the offline bench (the Phase 3 daemon
// `ocr.recognize` should use the same request configuration).
//
//   swiftc -O -target arm64-apple-macosx14.0 bench/tools/vision-ocr.swift -o bench/tools/bin/vision-ocr
//   vision-ocr [--fast] [--no-lc] [--langs zh-Hans,en-US] a.png b.png ...
//
// Prints one JSON object per image (JSON Lines):
//   {"image": "...", "latency_ms": 123.4, "width": W, "height": H,
//    "blocks": [{"text": "...", "bbox": [x, y, w, h], "confidence": 0.93}]}
// bbox is in image pixels, top-left origin. A first line {"init_ms": ...}
// reports process start -> ready (cold start).
import CoreGraphics
import Foundation
import ImageIO
import Vision

let start = DispatchTime.now()
var args = Array(CommandLine.arguments.dropFirst())
var level: VNRequestTextRecognitionLevel = .accurate
var languageCorrection = true
var langs = ["zh-Hans", "en-US"]
var images: [String] = []
while !args.isEmpty {
    let arg = args.removeFirst()
    switch arg {
    case "--fast": level = .fast
    case "--no-lc": languageCorrection = false
    case "--langs": langs = args.removeFirst().split(separator: ",").map(String.init)
    default: images.append(arg)
    }
}

func ms(since t: DispatchTime) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1e6
}

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

emit(["init_ms": ms(since: start), "level": level == .accurate ? "accurate" : "fast", "languageCorrection": languageCorrection, "langs": langs])

for path in images { autoreleasepool {
    let t0 = DispatchTime.now()
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        emit(["image": path, "error": "cannot decode image"])
        return
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = languageCorrection
    request.recognitionLanguages = langs
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        emit(["image": path, "error": String(describing: error)])
        return
    }
    let w = Double(image.width)
    let h = Double(image.height)
    let blocks: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox  // normalized, bottom-left origin
        return [
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "bbox": [box.minX * w, (1 - box.maxY) * h, box.width * w, box.height * h].map { ($0 * 10).rounded() / 10 },
        ]
    }
    emit(["image": path, "latency_ms": ms(since: t0), "width": image.width, "height": image.height, "blocks": blocks])
} }
