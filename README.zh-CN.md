# dsh-mac-use

[English](README.md) | 中文

让 DeepSeek Harness（dsh）操作本机 macOS 应用。插件增加「电脑操作」模式：模型只能查看和操作用户批准的应用，每个应用第一次被使用时都要用户在弹窗里同意；所有安全决定由本机的守护进程做出。

* 受 AzaiSakura/dsh-computer-use 启发，原型基于它的守护进程：<https://github.com/AzaiSakura/dsh-computer-use>

## 安装

需要 macOS 14 或更新版本、dsh 0.2.1-rc.2（网页版或桌面版）、Node.js 24、Xcode 命令行工具和 pnpm（`npm i -g pnpm`；桌面版自带）。

在 dsh 里：

1. 插件页 →「添加插件」→ 填入本仓库链接 `https://github.com/Rainshower258/dsh-mac-use` → 启用。
2. 插件详情页 →「守护进程」标签 →「安装守护进程」→「授予权限」。
3. 「模式检查」显示「正常」即完成。

要改代码的话，改为 clone 源码，在源码目录运行 `zsh scripts/install.sh`（检查前置条件并构建插件），第 1 步填源码的完整路径（例如 `/Users/<用户名>/cu-runtime`）。

## 使用

新建会话，模式选「电脑操作」，选一个支持图片输入的模型，直接提需求，例如"打开计算器，算 12×34"。模型第一次碰某个应用时会弹出授权窗口，由用户决定是否允许、允许到什么程度。

需要它立刻停下：

```sh
pkill -x cu-runtime
```

设置（应用名单、快捷键、隐私等）在插件页里修改；放宽任何一项都要在本机通过 Touch ID 或登录密码验证。

## 更多

- [使用说明](docs/desktop.md)：更新、卸载、授权、设置、权限排查。
- [设计说明](docs/DESIGN.zh-CN.md)：威胁模型、守护进程协议、插件结构、测试，以及修改代码要动哪里。

本项目以 MIT 许可发布。

## 问题反馈

- QQ 群：1126667506
- 邮箱：<devinwild48@gmail.com>
