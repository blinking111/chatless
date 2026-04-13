param(
  [switch]$SkipInstall,
  [switch]$SkipTypecheck,
  [switch]$Debug
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Require-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "缺少命令 '$name'。$hint"
  }
}

function Get-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Test-VsCppTools {
  $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
  if ($cl) {
    return $true
  }

  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return $false
  }

  $installPath = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return -not [string]::IsNullOrWhiteSpace($installPath)
}

function Invoke-Checked($file, $arguments) {
  Write-Host "$file $($arguments -join ' ')" -ForegroundColor DarkGray
  & $file @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败: $file $($arguments -join ' ')"
  }
}

$projectRoot = Get-ProjectRoot
Set-Location $projectRoot

Write-Step "检查构建环境"
Require-Command "node" "请先安装 Node.js 20+。"
Require-Command "pnpm" "请先安装 pnpm。"
Require-Command "rustc" "请先安装 Rust stable。"
Require-Command "cargo" "请先安装 Rust stable。"

if (-not (Test-VsCppTools)) {
  throw "未检测到 Visual Studio C++ 构建工具。请安装 'Desktop development with C++'。"
}

$nodeVersion = (& node --version).Trim()
$pnpmVersion = (& pnpm --version).Trim()
$rustVersion = (& rustc --version).Trim()

Write-Host "Node.js: $nodeVersion"
Write-Host "pnpm:    $pnpmVersion"
Write-Host "Rust:    $rustVersion"

if (-not $SkipInstall) {
  Write-Step "安装前端依赖"
  if (Test-Path "pnpm-lock.yaml") {
    Invoke-Checked "pnpm" @("install", "--frozen-lockfile")
  } else {
    Invoke-Checked "pnpm" @("install")
  }
}

if (-not $SkipTypecheck) {
  Write-Step "执行类型检查"
  Invoke-Checked "pnpm" @("typecheck")
}

Write-Step "构建 Windows 安装包"
$tauriArgs = @("tauri", "build")
if ($Debug) {
  $tauriArgs += "--debug"
}
Invoke-Checked "pnpm" $tauriArgs

$profile = if ($Debug) { "debug" } else { "release" }
$bundleRoot = Join-Path $projectRoot "src-tauri\target\$profile\bundle"

Write-Step "查找构建产物"
if (-not (Test-Path $bundleRoot)) {
  throw "未找到 bundle 目录: $bundleRoot"
}

$artifacts = @()
$artifacts += Get-ChildItem -Path (Join-Path $bundleRoot "msi") -Filter *.msi -ErrorAction SilentlyContinue
$artifacts += Get-ChildItem -Path (Join-Path $bundleRoot "nsis") -Include *.exe,*.exe.zip -ErrorAction SilentlyContinue

if ($artifacts.Count -eq 0) {
  Write-Warning "没有找到 .msi 或 .exe 产物。请检查上面的构建日志。"
} else {
  foreach ($artifact in $artifacts) {
    Write-Host $artifact.FullName -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Windows 打包完成。" -ForegroundColor Green
