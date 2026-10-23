# dsh-mac-use

English | [中文](README.zh-CN.md)

Lets DeepSeek Harness (dsh) operate apps on this Mac. The plugin adds a 电脑操作 ("computer use") mode: the model can see and act only in apps the user approved, the first use of each app has to be allowed by the user in a dialog, and every security decision is made by a local daemon.

* Inspired by AzaiSakura/dsh-computer-use; the prototype was built on its daemon: <https://github.com/AzaiSakura/dsh-computer-use>

## Install

Requires macOS 14 or later, dsh 0.2.1-rc.2 (the web client or the desktop app), Node.js 24, the Xcode Command Line Tools and pnpm (`npm i -g pnpm`; the desktop app brings its own).

In dsh:

1. Plugin page → 添加插件 (add plugin) → this repository's link, `https://github.com/Rainshower258/dsh-mac-use` → enable it.
2. The plugin's detail page → 守护进程 (daemon) tab → 安装守护进程 (install daemon) → 授予权限 (grant permissions).
3. Done when the 模式检查 (mode check) shows 正常 (OK).

To work on the code instead, clone it, run `zsh scripts/install.sh` in the checkout (checks the requirements and builds the plugin), and add the checkout's full path in step 1 (e.g. `/Users/<name>/cu-runtime`).

## Use

Start a session in the 电脑操作 mode, pick a model that takes images, and ask, e.g. "open Calculator and compute 12×34". The first time the model touches an app, an approval dialog lets the user decide whether to allow it, and how far.

To stop it at once:

```sh
pkill -x cu-runtime
```

Settings (app lists, key chords, privacy and more) are changed on the plugin page; loosening any of them needs Touch ID or the login password on this Mac.

## More

- [User guide](docs/desktop.md) (Chinese): update, uninstall, approvals, settings, permission troubleshooting.
- [Design](docs/DESIGN.md): threat model, the daemon's protocol, the plugin's structure, tests, and where to change what.

Released under the MIT license.

## Bug reports

- QQ group: 1126667506
- Email: <devinwild48@gmail.com>
