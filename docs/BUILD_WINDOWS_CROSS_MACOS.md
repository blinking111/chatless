# macOS 本地交叉打 Windows 包

这个方案是给必须在 macOS 本地硬做 Windows 构建的人用的。

它不是首选方案。Tauri 官方明确说明：在 Linux 和 macOS 上交叉构建 Windows 包是可行的，但使用 NSIS 时有不少 caveat，稳定性不如直接在 Windows 或 CI 上构建。

官方文档：

- Tauri Windows Installer: <https://v2.tauri.app/distribute/windows-installer/>

## 这套脚本做什么

脚本文件：

- `scripts/build-windows-cross-macos.sh`

它会：

- 检查 `node`、`pnpm`、`rustup`、`cargo`
- 检查 `cargo-xwin`
- 检查 Homebrew 的 `nsis` 和 `llvm`
- 自动执行 `rustup target add x86_64-pc-windows-msvc`
- 跑 `pnpm install`
- 跑 `pnpm typecheck`
- 执行 `pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`
- 列出交叉构建产物路径

## 前置环境

先安装这些依赖：

```bash
brew install nsis llvm
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
```

说明：

- `nsis` 用于生成 Windows 安装程序
- `llvm` 提供 `lld-link`、`llvm-lib`、`llvm-dlltool`、`llvm-rc`
- `cargo-xwin` 用来在 macOS 上拉取 Windows SDK 并驱动 MSVC target 构建

如果你是 Apple Silicon，`llvm` 通常会安装在：

```text
/opt/homebrew/opt/llvm/bin
```

脚本会自动把这个路径加到当前进程的 `PATH`。

## 运行

在项目根目录执行：

```bash
chmod +x scripts/build-windows-cross-macos.sh
./scripts/build-windows-cross-macos.sh
```

也可以通过 `pnpm`：

```bash
pnpm build:windows:cross:mac
```

## 可选参数

跳过依赖安装：

```bash
./scripts/build-windows-cross-macos.sh --skip-install
```

跳过类型检查：

```bash
./scripts/build-windows-cross-macos.sh --skip-typecheck
```

构建 debug 包：

```bash
./scripts/build-windows-cross-macos.sh --debug
```

指定目标架构：

```bash
./scripts/build-windows-cross-macos.sh --target aarch64-pc-windows-msvc
```

## 产物位置

64 位 Windows 默认在：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

常见产物：

- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe.zip`

`msi` 不要当成 macOS 交叉构建的默认目标。Tauri 官方文档明确写了：`msi` 只能在 Windows 上创建。

## 已知限制

- 这个方案不如 Windows 本机构建稳定
- 代码签名不能用默认 Windows 签名流程，需要自定义签名命令
- 首次构建会下载 Windows SDK，耗时比较长
- 某些依赖如果在构建脚本里强依赖 Windows 工具链，仍可能失败
- 如果你只是要给别人发包，优先考虑 GitHub Actions 或 Windows 虚拟机

## 故障排查

如果看到 `makensis` 不存在：

```bash
brew install nsis
```

如果看到 `lld-link` 或 `llvm-rc` 不存在：

```bash
brew install llvm
```

如果看到 `cargo-xwin: command not found`：

```bash
cargo install --locked cargo-xwin
```

如果 bundle 目录里没有安装包，先看 `pnpm tauri build` 输出；多数情况下是：

- LLVM 没进 `PATH`
- `cargo-xwin` 没装好
- Windows SDK 首次下载失败
- 项目依赖在 Windows target 下编译失败
