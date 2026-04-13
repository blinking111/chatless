# 本地打 Windows 包

在 Windows 机器上执行，不建议在 macOS 上直接交叉打包。

## 前置环境

- Node.js 20+
- pnpm
- Rust stable
- Visual Studio Build Tools
  - 需要勾选 `Desktop development with C++`

## 一键脚本

在项目根目录执行：

```powershell
.\scripts\build-windows-local.ps1
```

也可以双击或命令行执行：

```cmd
scripts\build-windows-local.cmd
```

## 可选参数

跳过依赖安装：

```powershell
.\scripts\build-windows-local.ps1 -SkipInstall
```

跳过类型检查：

```powershell
.\scripts\build-windows-local.ps1 -SkipTypecheck
```

构建调试包：

```powershell
.\scripts\build-windows-local.ps1 -Debug
```

## 产物位置

正式包默认在：

```text
src-tauri\target\release\bundle\
```

常见产物：

- `src-tauri\target\release\bundle\msi\*.msi`
- `src-tauri\target\release\bundle\nsis\*.exe`
- `src-tauri\target\release\bundle\nsis\*.exe.zip`

## 说明

- 脚本内部会调用 `pnpm tauri build`
- 前端静态导出目录已由项目配置到 `dist`
- 如果构建失败，优先检查：
  - `pnpm install` 是否成功
  - Rust toolchain 是否完整
  - Visual Studio C++ 工具链是否安装
