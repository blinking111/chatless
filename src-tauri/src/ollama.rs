use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use futures_util::StreamExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaSystemStatus {
  pub installed: bool,
  pub running: bool,
  pub version: Option<String>,
  pub command_path: Option<String>,
  pub base_url: String,
  pub platform: String,
  pub install_url: String,
  pub install_command: Option<String>,
  pub start_command: Option<String>,
  pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelSummary {
  pub name: String,
  pub size: Option<u64>,
  pub digest: Option<String>,
  #[serde(alias = "modified_at")]
  pub modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
  models: Option<Vec<OllamaModelSummary>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgressEvent {
  model: String,
  status: String,
  completed: Option<u64>,
  total: Option<u64>,
  percent: Option<f64>,
  done: bool,
  error: Option<String>,
}

#[derive(Clone, Default)]
pub struct OllamaPullState {
  canceled: Arc<Mutex<HashSet<String>>>,
  active: Arc<Mutex<HashSet<String>>>,
  progress: Arc<Mutex<HashMap<String, OllamaPullProgressEvent>>>,
}

impl OllamaPullState {
  fn request_cancel(&self, model: &str) {
    if let Ok(mut canceled) = self.canceled.lock() {
      canceled.insert(model.to_string());
    }
  }

  fn take_if_canceled(&self, model: &str) -> bool {
    if let Ok(mut canceled) = self.canceled.lock() {
      canceled.remove(model)
    } else {
      false
    }
  }

  fn clear(&self, model: &str) {
    if let Ok(mut canceled) = self.canceled.lock() {
      canceled.remove(model);
    }
  }

  fn start(&self, model: &str) {
    if let Ok(mut active) = self.active.lock() {
      active.insert(model.to_string());
    }
  }

  fn finish(&self, model: &str) {
    if let Ok(mut active) = self.active.lock() {
      active.remove(model);
    }
  }

  fn set_progress(&self, event: OllamaPullProgressEvent) {
    if let Ok(mut progress) = self.progress.lock() {
      progress.insert(event.model.clone(), event);
    }
  }

  fn clear_progress(&self, model: &str) {
    if let Ok(mut progress) = self.progress.lock() {
      progress.remove(model);
    }
  }

  fn list_progress(&self) -> Vec<OllamaPullProgressEvent> {
    if let Ok(progress) = self.progress.lock() {
      progress.values().cloned().collect()
    } else {
      Vec::new()
    }
  }
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInstallStatus {
  pub running: bool,
  pub supported: bool,
  pub phase: String,
  pub progress: f64,
  pub logs: Vec<String>,
  pub error: Option<String>,
  pub done: bool,
}

#[derive(Clone, Default)]
pub struct OllamaInstallState {
  inner: Arc<Mutex<OllamaInstallStatus>>,
}

impl OllamaInstallState {
  fn snapshot(&self) -> OllamaInstallStatus {
    self.inner.lock().map(|s| s.clone()).unwrap_or_default()
  }

  fn reset(&self) {
    if let Ok(mut inner) = self.inner.lock() {
      *inner = OllamaInstallStatus {
        running: true,
        supported: cfg!(target_os = "macos") || cfg!(target_os = "windows"),
        phase: "准备安装".to_string(),
        progress: 0.0,
        logs: vec!["开始准备安装 Ollama...".to_string()],
        error: None,
        done: false,
      };
    }
  }

  fn set_phase(&self, phase: &str, progress: f64) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.phase = phase.to_string();
      inner.progress = progress.clamp(0.0, 100.0);
    }
  }

  fn append_log(&self, line: impl Into<String>) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.logs.push(line.into());
      if inner.logs.len() > 400 {
        let drain = inner.logs.len().saturating_sub(400);
        inner.logs.drain(0..drain);
      }
    }
  }

  fn fail(&self, message: impl Into<String>) {
    if let Ok(mut inner) = self.inner.lock() {
      let msg = message.into();
      inner.running = false;
      inner.done = true;
      inner.error = Some(msg.clone());
      inner.phase = "安装失败".to_string();
      inner.logs.push(msg);
    }
  }

  fn complete(&self) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.running = false;
      inner.done = true;
      inner.error = None;
      inner.phase = "安装完成".to_string();
      inner.progress = 100.0;
      inner.logs.push("Ollama 安装完成。".to_string());
    }
  }
}

fn emit_install_status(app: &tauri::AppHandle, state: &OllamaInstallState) {
  let _ = app.emit("ollama-install-status", state.snapshot());
}

fn append_install_log(app: &tauri::AppHandle, state: &OllamaInstallState, line: impl Into<String>) {
  state.append_log(line);
  emit_install_status(app, state);
}

fn set_install_phase(app: &tauri::AppHandle, state: &OllamaInstallState, phase: &str, progress: f64) {
  state.set_phase(phase, progress);
  emit_install_status(app, state);
}

fn finish_install_error(app: &tauri::AppHandle, state: &OllamaInstallState, message: impl Into<String>) {
  state.fail(message);
  emit_install_status(app, state);
}

fn finish_install_success(app: &tauri::AppHandle, state: &OllamaInstallState) {
  state.complete();
  emit_install_status(app, state);
}

async fn pump_process_logs(
  mut child: tokio::process::Child,
  app: &tauri::AppHandle,
  state: &OllamaInstallState,
  phase: &str,
  start_progress: f64,
  end_progress: f64,
) -> Result<(), String> {
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

  if let Some(stdout) = stdout {
    let tx_out = tx.clone();
    tauri::async_runtime::spawn(async move {
      use tokio::io::{AsyncBufReadExt, BufReader};
      let mut lines = BufReader::new(stdout).lines();
      while let Ok(Some(line)) = lines.next_line().await {
        let _ = tx_out.send(line);
      }
    });
  }

  if let Some(stderr) = stderr {
    let tx_err = tx.clone();
    tauri::async_runtime::spawn(async move {
      use tokio::io::{AsyncBufReadExt, BufReader};
      let mut lines = BufReader::new(stderr).lines();
      while let Ok(Some(line)) = lines.next_line().await {
        let _ = tx_err.send(line);
      }
    });
  }

  let mut tick = 0u32;

  loop {
    while let Ok(line) = rx.try_recv() {
      let trimmed = line.trim();
      if !trimmed.is_empty() {
        append_install_log(app, state, trimmed.to_string());
      }
    }

    if let Some(status) = child.try_wait().map_err(|err| format!("等待安装进程失败: {err}"))? {
      while let Ok(line) = rx.try_recv() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
          append_install_log(app, state, trimmed.to_string());
        }
      }
      if !status.success() {
        return Err(format!("安装进程退出失败: {status}"));
      }
      set_install_phase(app, state, phase, end_progress);
      return Ok(());
    }

    tick = tick.saturating_add(1);
    let progress = (start_progress + (tick as f64 * 0.8)).min(end_progress - 0.5);
    set_install_phase(app, state, phase, progress);
    tokio::time::sleep(Duration::from_millis(500)).await;
  }
}

async fn run_macos_install(app: tauri::AppHandle, state: OllamaInstallState) -> Result<(), String> {
  let base_url = "http://localhost:11434";
  append_install_log(&app, &state, "执行官方安装命令: curl -fsSL https://ollama.com/install.sh | sh");
  set_install_phase(&app, &state, "执行官方安装脚本", 10.0);

  let child = tokio::process::Command::new("sh")
    .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| format!("启动官方安装脚本失败: {err}"))?;

  pump_process_logs(child, &app, &state, "执行官方安装脚本", 10.0, 95.0).await?;

  append_install_log(&app, &state, "等待 Ollama 服务启动...");
  for _ in 0..20 {
    tokio::time::sleep(Duration::from_millis(500)).await;
    if ping_ollama(base_url).await.is_ok() {
      append_install_log(&app, &state, "Ollama 服务已响应。");
      return Ok(());
    }
  }

  append_install_log(&app, &state, "安装完成，但尚未检测到服务响应。");
  Ok(())
}

async fn run_windows_install(app: tauri::AppHandle, state: OllamaInstallState) -> Result<(), String> {
  append_install_log(&app, &state, "执行官方安装命令: irm https://ollama.com/install.ps1 | iex");
  set_install_phase(&app, &state, "执行官方安装脚本", 10.0);
  let child = tokio::process::Command::new("powershell")
    .args([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm https://ollama.com/install.ps1 | iex",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| format!("启动官方安装脚本失败: {err}"))?;

  pump_process_logs(child, &app, &state, "执行官方安装脚本", 10.0, 95.0).await?;
  append_install_log(&app, &state, "Windows 安装完成，请稍候刷新状态。");
  Ok(())
}

async fn run_ollama_install(app: tauri::AppHandle, state: OllamaInstallState) {
  let result = if cfg!(target_os = "macos") {
    run_macos_install(app.clone(), state.clone()).await
  } else if cfg!(target_os = "windows") {
    run_windows_install(app.clone(), state.clone()).await
  } else {
    Err("当前平台暂不支持应用内一键安装 Ollama".to_string())
  };

  match result {
    Ok(()) => finish_install_success(&app, &state),
    Err(message) => finish_install_error(&app, &state, message),
  }
}

fn platform_name() -> String {
  if cfg!(target_os = "macos") {
    "macOS".to_string()
  } else if cfg!(target_os = "windows") {
    "Windows".to_string()
  } else if cfg!(target_os = "linux") {
    "Linux".to_string()
  } else {
    "Unknown".to_string()
  }
}

fn default_base_url(base_url: Option<String>) -> String {
  let raw = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
  let trimmed = raw.trim().trim_end_matches('/').to_string();
  if trimmed.is_empty() {
    "http://localhost:11434".to_string()
  } else {
    trimmed
  }
}

fn install_command_for_platform() -> Option<String> {
  if cfg!(target_os = "macos") {
    Some("brew install ollama".to_string())
  } else if cfg!(target_os = "linux") {
    Some("curl -fsSL https://ollama.com/install.sh | sh".to_string())
  } else {
    None
  }
}

fn start_command_for_platform() -> Option<String> {
  if cfg!(target_os = "windows") {
    None
  } else {
    Some("ollama serve".to_string())
  }
}

fn path_candidates() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  if let Some(path_os) = env::var_os("PATH") {
    for dir in env::split_paths(&path_os) {
      if cfg!(target_os = "windows") {
        candidates.push(dir.join("ollama.exe"));
        candidates.push(dir.join("ollama.cmd"));
        candidates.push(dir.join("ollama.bat"));
      } else {
        candidates.push(dir.join("ollama"));
      }
    }
  }

  if cfg!(target_os = "macos") {
    candidates.push(PathBuf::from("/usr/local/bin/ollama"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/ollama"));
    candidates.push(PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"));
  } else if cfg!(target_os = "linux") {
    candidates.push(PathBuf::from("/usr/bin/ollama"));
    candidates.push(PathBuf::from("/usr/local/bin/ollama"));
  } else if cfg!(target_os = "windows") {
    candidates.push(PathBuf::from(r"C:\Users\Default\AppData\Local\Programs\Ollama\ollama.exe"));
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
      candidates.push(PathBuf::from(local_app_data).join("Programs").join("Ollama").join("ollama.exe"));
    }
  }

  candidates
}

fn resolve_ollama_path() -> Option<PathBuf> {
  path_candidates()
    .into_iter()
    .find(|path| path.exists() && path.is_file())
}

fn read_version(path: &Path) -> Option<String> {
  let output = Command::new(path).arg("--version").output().ok()?;
  if !output.status.success() {
    return None;
  }

  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if !stdout.is_empty() {
    return Some(stdout);
  }

  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if stderr.is_empty() {
    None
  } else {
    Some(stderr)
  }
}

fn ollama_command_path() -> String {
  resolve_ollama_path()
    .map(|path| path.to_string_lossy().to_string())
    .unwrap_or_else(|| {
      if cfg!(target_os = "windows") {
        "ollama.exe".to_string()
      } else {
        "ollama".to_string()
      }
    })
}

async fn ping_ollama(base_url: &str) -> Result<(), String> {
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(2))
    .build()
    .map_err(|err| err.to_string())?;

  let response = client
    .get(format!("{base_url}/api/tags"))
    .send()
    .await
    .map_err(|err| err.to_string())?;

  if response.status().is_success() {
    Ok(())
  } else {
    Err(format!("HTTP {}", response.status()))
  }
}

#[tauri::command]
pub async fn get_ollama_system_status(base_url: Option<String>) -> Result<OllamaSystemStatus, String> {
  let base_url = default_base_url(base_url);
  let command_path = resolve_ollama_path();
  let version = command_path.as_ref().and_then(|path| read_version(path));
  let running_result = ping_ollama(&base_url).await;

  let error = if command_path.is_none() {
    None
  } else {
    running_result.err()
  };

  Ok(OllamaSystemStatus {
    installed: command_path.is_some(),
    running: error.is_none() && command_path.is_some(),
    version,
    command_path: command_path.map(|path| path.to_string_lossy().to_string()),
    base_url,
    platform: platform_name(),
    install_url: "https://ollama.com/download".to_string(),
    install_command: install_command_for_platform(),
    start_command: start_command_for_platform(),
    error,
  })
}

#[tauri::command]
pub fn get_ollama_install_status(state: tauri::State<'_, OllamaInstallState>) -> Result<OllamaInstallStatus, String> {
  Ok(state.snapshot())
}

#[tauri::command]
pub fn install_ollama(app: tauri::AppHandle, state: tauri::State<'_, OllamaInstallState>) -> Result<String, String> {
  if state.snapshot().running {
    return Err("Ollama 安装任务已在进行中".to_string());
  }
  state.reset();
  emit_install_status(&app, &state);
  let app_handle = app.clone();
  let install_state = state.inner().clone();
  tauri::async_runtime::spawn(async move {
    run_ollama_install(app_handle, install_state).await;
  });
  Ok("已开始安装 Ollama".to_string())
}

#[tauri::command]
pub async fn start_ollama_service(base_url: Option<String>) -> Result<String, String> {
  let base_url = default_base_url(base_url);
  let command_path = ollama_command_path();

  if ping_ollama(&base_url).await.is_ok() {
    return Ok("Ollama 服务已在运行".to_string());
  }

  let mut command = Command::new(command_path);
  command
    .arg("serve")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
  }

  command
    .spawn()
    .map_err(|err| format!("启动 Ollama 服务失败: {err}"))?;

  for _ in 0..20 {
    tokio::time::sleep(Duration::from_millis(500)).await;
    if ping_ollama(&base_url).await.is_ok() {
      return Ok("Ollama 服务已启动".to_string());
    }
  }

  Err("已发起启动，但未在预期时间内检测到服务".to_string())
}

#[tauri::command]
pub async fn stop_ollama_service(base_url: Option<String>) -> Result<String, String> {
  let base_url = default_base_url(base_url);

  #[cfg(target_os = "windows")]
  let output = Command::new("taskkill")
    .args(["/IM", "ollama.exe", "/F"])
    .output()
    .map_err(|err| format!("停止 Ollama 服务失败: {err}"))?;

  #[cfg(not(target_os = "windows"))]
  let output = Command::new("pkill")
    .args(["-f", "ollama serve"])
    .output()
    .map_err(|err| format!("停止 Ollama 服务失败: {err}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if ping_ollama(&base_url).await.is_err() {
      return Ok("Ollama 服务已停止".to_string());
    }
    return Err(if stderr.is_empty() {
      "停止 Ollama 服务失败".to_string()
    } else {
      stderr
    });
  }

  for _ in 0..20 {
    tokio::time::sleep(Duration::from_millis(300)).await;
    if ping_ollama(&base_url).await.is_err() {
      return Ok("Ollama 服务已停止".to_string());
    }
  }

  Err("已发送停止命令，但服务仍在响应".to_string())
}

#[tauri::command]
pub async fn list_ollama_models(base_url: Option<String>) -> Result<Vec<OllamaModelSummary>, String> {
  let base_url = default_base_url(base_url);
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(10))
    .build()
    .map_err(|err| err.to_string())?;

  let response = client
    .get(format!("{base_url}/api/tags"))
    .send()
    .await
    .map_err(|err| format!("无法连接到 Ollama: {err}"))?;

  if !response.status().is_success() {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    return Err(format!("Ollama 返回错误: {status} {body}"));
  }

  let mut payload = response
    .json::<OllamaTagsResponse>()
    .await
    .map_err(|err| format!("解析 Ollama 模型列表失败: {err}"))?;

  let mut models = payload.models.take().unwrap_or_default();
  models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  Ok(models)
}

#[tauri::command]
pub async fn pull_ollama_model(
  app: tauri::AppHandle,
  state: tauri::State<'_, OllamaPullState>,
  base_url: Option<String>,
  model: String,
) -> Result<String, String> {
  let base_url = default_base_url(base_url);
  let name = model.trim();
  if name.is_empty() {
    return Err("模型名称不能为空".to_string());
  }
  state.clear(name);
  state.start(name);

  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(60 * 60))
    .build()
    .map_err(|err| err.to_string())?;

  let response = client
    .post(format!("{base_url}/api/pull"))
    .json(&json!({
      "name": name,
      "stream": true
    }))
    .send()
    .await
    .map_err(|err| format!("调用 Ollama 下载模型失败: {err}"))?;

  if !response.status().is_success() {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    return Err(format!("下载失败: {status} {body}"));
  }

  let start_event = OllamaPullProgressEvent {
    model: name.to_string(),
    status: "开始下载".to_string(),
    completed: Some(0),
    total: None,
    percent: Some(0.0),
    done: false,
    error: None,
  };
  state.set_progress(start_event.clone());
  let _ = app.emit("ollama-pull-progress", start_event);

  let mut stream = response.bytes_stream();
  let mut buffer = String::new();
  let mut final_status = "模型下载完成".to_string();

  while let Some(chunk) = stream.next().await {
    if state.take_if_canceled(name) {
      let cancel_event = OllamaPullProgressEvent {
        model: name.to_string(),
        status: "已取消".to_string(),
        completed: None,
        total: None,
        percent: None,
        done: true,
        error: None,
      };
      state.finish(name);
      state.clear_progress(name);
      let _ = app.emit("ollama-pull-progress", cancel_event);
      return Ok("模型下载已取消".to_string());
    }

    let chunk = chunk.map_err(|err| format!("读取下载进度失败: {err}"))?;
    buffer.push_str(&String::from_utf8_lossy(&chunk));

    while let Some(index) = buffer.find('\n') {
      let line = buffer[..index].trim().to_string();
      buffer = buffer[index + 1..].to_string();
      if line.is_empty() {
        continue;
      }

      let payload = serde_json::from_str::<serde_json::Value>(&line)
        .map_err(|err| format!("解析下载进度失败: {err}"))?;

      if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
        let error_event = OllamaPullProgressEvent {
          model: name.to_string(),
          status: "下载失败".to_string(),
          completed: None,
          total: None,
          percent: None,
          done: true,
          error: Some(error.to_string()),
        };
        state.finish(name);
        state.clear_progress(name);
        let _ = app.emit("ollama-pull-progress", error_event);
        return Err(error.to_string());
      }

      let status = payload
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("下载中")
        .to_string();
      let completed = payload.get("completed").and_then(|value| value.as_u64());
      let total = payload.get("total").and_then(|value| value.as_u64());
      let percent = match (completed, total) {
        (Some(c), Some(t)) if t > 0 => Some(((c as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
        _ => None,
      };
      let done = status == "success";
      final_status = if done { "模型下载完成".to_string() } else { status.clone() };

      let progress_event = OllamaPullProgressEvent {
        model: name.to_string(),
        status,
        completed,
        total,
        percent,
        done,
        error: None,
      };
      if progress_event.done {
        state.finish(name);
        state.clear_progress(name);
      } else {
        state.set_progress(progress_event.clone());
      }
      let _ = app.emit("ollama-pull-progress", progress_event);
    }
  }

  if !buffer.trim().is_empty() {
    let payload = serde_json::from_str::<serde_json::Value>(buffer.trim())
      .map_err(|err| format!("解析下载结果失败: {err}"))?;
    if let Some(status) = payload.get("status").and_then(|value| value.as_str()) {
      final_status = if status == "success" {
        "模型下载完成".to_string()
      } else {
        status.to_string()
      };
    }
  }

  let final_event = OllamaPullProgressEvent {
    model: name.to_string(),
    status: final_status.clone(),
    completed: None,
    total: None,
    percent: Some(100.0),
    done: true,
    error: None,
  };
  state.finish(name);
  state.clear_progress(name);
  let _ = app.emit("ollama-pull-progress", final_event);

  Ok(final_status)
}

#[tauri::command]
pub fn cancel_ollama_pull(state: tauri::State<'_, OllamaPullState>, model: String) -> Result<(), String> {
  let name = model.trim();
  if name.is_empty() {
    return Err("模型名称不能为空".to_string());
  }
  state.request_cancel(name);
  Ok(())
}

#[tauri::command]
pub fn list_ollama_pull_progress(state: tauri::State<'_, OllamaPullState>) -> Result<Vec<OllamaPullProgressEvent>, String> {
  Ok(state.list_progress())
}

#[tauri::command]
pub async fn delete_ollama_model(base_url: Option<String>, model: String) -> Result<String, String> {
  let base_url = default_base_url(base_url);
  let name = model.trim();
  if name.is_empty() {
    return Err("模型名称不能为空".to_string());
  }

  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(60))
    .build()
    .map_err(|err| err.to_string())?;

  let response = client
    .delete(format!("{base_url}/api/delete"))
    .json(&json!({
      "name": name
    }))
    .send()
    .await
    .map_err(|err| format!("调用 Ollama 删除模型失败: {err}"))?;

  if !response.status().is_success() {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    return Err(format!("删除失败: {status} {body}"));
  }

  let body = response
    .text()
    .await
    .map_err(|err| format!("读取删除结果失败: {err}"))?;

  if body.trim().is_empty() {
    return Ok("模型删除完成".to_string());
  }

  let payload = serde_json::from_str::<serde_json::Value>(&body)
    .map_err(|err| format!("解析删除结果失败: {err}"))?;

  if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
    return Err(error.to_string());
  }

  let message = payload
    .get("status")
    .and_then(|value| value.as_str())
    .unwrap_or("模型删除完成")
    .to_string();

  Ok(message)
}
