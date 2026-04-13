#!/usr/bin/env bash

set -euo pipefail

SKIP_INSTALL=0
SKIP_TYPECHECK=0
DEBUG=0
TARGET="x86_64-pc-windows-msvc"
PROFILE="release"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-typecheck)
      SKIP_TYPECHECK=1
      shift
      ;;
    --debug)
      DEBUG=1
      PROFILE="debug"
      shift
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "缺少 --target 的值" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
用法:
  ./scripts/build-windows-cross-macos.sh [--skip-install] [--skip-typecheck] [--debug] [--target <triple>]

示例:
  ./scripts/build-windows-cross-macos.sh
  ./scripts/build-windows-cross-macos.sh --skip-install
  ./scripts/build-windows-cross-macos.sh --target aarch64-pc-windows-msvc
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  local name="$1"
  local hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "缺少命令 '${name}'。${hint}" >&2
    exit 1
  fi
}

run_checked() {
  printf '%s\n' "$*" >&2
  "$@"
}

cd "$PROJECT_ROOT"

step "检查构建环境"
require_command node "请先安装 Node.js 20+。"
require_command pnpm "请先安装 pnpm。"
require_command rustup "请先安装 Rust stable。"
require_command cargo "请先安装 Rust stable。"
require_command brew "请先安装 Homebrew。"

if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "缺少命令 'cargo-xwin'。请先执行: cargo install --locked cargo-xwin" >&2
  exit 1
fi

if ! command -v makensis >/dev/null 2>&1; then
  echo "缺少命令 'makensis'。请先执行: brew install nsis" >&2
  exit 1
fi

LLVM_PREFIX="$(brew --prefix llvm@18 2>/dev/null || brew --prefix llvm 2>/dev/null || true)"
if [[ -z "$LLVM_PREFIX" || ! -x "$LLVM_PREFIX/bin/llvm-lib" ]]; then
  echo "未检测到 Homebrew LLVM。请先执行: brew install llvm@18" >&2
  exit 1
fi

export PATH="$LLVM_PREFIX/bin:$PATH"

require_command lld-link "未找到 lld-link，请确认 LLVM 安装完整。"
require_command llvm-lib "未找到 llvm-lib，请确认 LLVM 安装完整。"
require_command llvm-dlltool "未找到 llvm-dlltool，请确认 LLVM 安装完整。"
require_command llvm-rc "未找到 llvm-rc，请确认 LLVM 安装完整。"

step "准备 Rust Windows target"
run_checked rustup target add "$TARGET"

printf 'Node.js: %s\n' "$(node --version)"
printf 'pnpm:    %s\n' "$(pnpm --version)"
printf 'Rust:    %s\n' "$(rustc --version)"
printf 'Target:  %s\n' "$TARGET"
printf 'LLVM:    %s\n' "$LLVM_PREFIX"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  step "安装前端依赖"
  if [[ -f pnpm-lock.yaml ]]; then
    run_checked pnpm install --frozen-lockfile
  else
    run_checked pnpm install
  fi
fi

if [[ "$SKIP_TYPECHECK" -eq 0 ]]; then
  step "执行类型检查"
  run_checked pnpm typecheck
fi

step "执行 Tauri Windows 交叉构建"
TAURI_ARGS=(tauri build --runner cargo-xwin --target "$TARGET")
if [[ "$DEBUG" -eq 1 ]]; then
  TAURI_ARGS+=(--debug)
fi
run_checked pnpm "${TAURI_ARGS[@]}"

step "查找构建产物"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/$TARGET/$PROFILE/bundle"
if [[ ! -d "$BUNDLE_ROOT" ]]; then
  echo "未找到 bundle 目录: $BUNDLE_ROOT" >&2
  exit 1
fi

FOUND=0
while IFS= read -r artifact; do
  FOUND=1
  printf '%s\n' "$artifact"
done < <(find "$BUNDLE_ROOT" \( -name '*.exe' -o -name '*.exe.zip' -o -name '*.msi' \) | sort)

if [[ "$FOUND" -eq 0 ]]; then
  echo "没有找到 .exe/.exe.zip/.msi 产物。请检查上面的构建日志。" >&2
  exit 1
fi

printf '\nWindows 交叉打包完成。\n'
