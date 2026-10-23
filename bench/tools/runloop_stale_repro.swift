import AppKit
// Mimic CUADaemon: query runningApplications from a background thread while
// the main thread never spins a run loop.
func pids() -> [pid_t] { NSWorkspace.shared.runningApplications.filter { $0.localizedName == "DSHFixture" }.map { $0.processIdentifier } }
let fx = CommandLine.arguments[1]
Thread.detachNewThread {
  print("before launch:", pids())
  let p = Process(); p.executableURL = URL(fileURLWithPath: fx); p.arguments = ["--mode", "canvas"]; try! p.run()
  sleep(4); print("after launch (fixture pid \(p.processIdentifier)):", pids())
  p.terminate(); sleep(2); print("after terminate:", pids())
  exit(0)
}
while true { sleep(1) }  // main thread blocked, like the accept loop
