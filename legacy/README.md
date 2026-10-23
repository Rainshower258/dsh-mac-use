# legacy/

Our changes to the upstream daemon [AzaiSakura/dsh-computer-use](https://github.com/AzaiSakura/dsh-computer-use),
kept as patches instead of pushing the fork. The upstream history is public already; only these commits are ours.
They modify MIT-licensed upstream code, so the upstream license is included as `LICENSE-upstream-MIT`.

Base: upstream `a572908`. Apply in order and build:

```sh
git checkout a572908
git am legacy/patches/*.patch
(cd native && swift build)
```

| patch | what |
|---|---|
| 0001 | spin the main run loop so `NSWorkspace` running-app list stays fresh (apps launched after daemon start were invisible) |
| 0002 | refuse coordinate clicks/drags that land outside the target app's windows |
| 0003 | drop the system Apple menu from the AX tree (the model could reach Force Quit / Restart; it also leaked "Recent Items") |
| 0004 | refuse key/text input unless the target app is verifiably frontmost |

The bench's legacy A0/A1 arms run against a local checkout of the fork with these patches applied (`DSH_CU_LEGACY`).
Verified 2026-09-28: all four apply cleanly on `a572908` and `swift build` succeeds.
