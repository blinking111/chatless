"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { linkOpener } from "@/lib/utils/linkOpener";
import { useProviderStore } from "@/store/providerStore";
import { useOllamaStore } from "@/store/ollamaStore";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  Logs,
  Play,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";

interface OllamaSystemStatus {
  installed: boolean;
  running: boolean;
  version?: string | null;
  commandPath?: string | null;
  baseUrl: string;
  platform: string;
  installUrl: string;
  installCommand?: string | null;
  startCommand?: string | null;
  error?: string | null;
}

interface OllamaModelSummary {
  name: string;
  size?: number | null;
  digest?: string | null;
  modifiedAt?: string | null;
}

interface OllamaCatalogItem {
  name: string;
  title: string;
  description: string;
  size: string;
  tags: string[];
}

interface OllamaPullProgressEvent {
  model: string;
  status: string;
  completed?: number | null;
  total?: number | null;
  percent?: number | null;
  done: boolean;
  error?: string | null;
}

interface OllamaInstallStatus {
  running: boolean;
  supported: boolean;
  phase: string;
  progress: number;
  logs: string[];
  error?: string | null;
  done: boolean;
}

const CANCELED_STATUS = "已取消";

const RECOMMENDED_MODELS: OllamaCatalogItem[] = [
  {
    name: "gemma4:e2b",
    title: "Gemma 4 E2B",
    description: "更轻量的 Gemma 4 版本，适合本地快速运行。",
    size: "约 1.7GB",
    tags: ["轻量", "Gemma 4"],
  },
  {
    name: "gemma4:e4b",
    title: "Gemma 4 E4B",
    description: "更强一些的 Gemma 4 版本，适合日常对话与更复杂任务。",
    size: "约 3.2GB",
    tags: ["通用", "Gemma 4"],
  },
];

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(value?: string | null): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function OllamaLocalManager() {
  const providers = useProviderStore((state) => state.providers);
  const refreshOllamaModels = useOllamaStore((state) => state.refreshModels);
  const setOllamaModels = useOllamaStore((state) => state.setModels);

  const providerBaseUrl = useMemo(() => {
    const provider = providers.find((item) => item.name === "Ollama");
    return provider?.url?.trim() || "http://localhost:11434";
  }, [providers]);

  const [status, setStatus] = useState<OllamaSystemStatus | null>(null);
  const [installStatus, setInstallStatus] = useState<OllamaInstallStatus | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installedModels, setInstalledModelsList] = useState<OllamaModelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [serviceAction, setServiceAction] = useState<"starting" | "stopping" | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, OllamaPullProgressEvent>>({});

  const syncModels = useCallback(async (baseUrl: string) => {
    const models = await invoke<OllamaModelSummary[]>("list_ollama_models", { baseUrl });
    setInstalledModelsList(models);
    setOllamaModels(models.map((item) => item.name));
    try {
      await refreshOllamaModels(baseUrl);
    } catch (error) {
      console.warn("[OllamaLocalManager] 同步 provider 模型仓库失败", error);
    }
  }, [refreshOllamaModels, setOllamaModels]);

  const refreshData = useCallback(async (showToast = false) => {
    const shouldShowToast = showToast;
    setRefreshing(true);
    try {
      const nextStatus = await invoke<OllamaSystemStatus>("get_ollama_system_status", { baseUrl: providerBaseUrl });
      setStatus(nextStatus);

      if (nextStatus.installed && nextStatus.running) {
        await syncModels(nextStatus.baseUrl);
      } else {
        setInstalledModelsList([]);
        setOllamaModels([]);
      }

      if (shouldShowToast) {
        toast.success("Ollama 状态已刷新");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (showToast) {
        toast.error("刷新 Ollama 状态失败", { description: message });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [providerBaseUrl, setOllamaModels, syncModels]);

  const hydrateInstallStatus = useCallback(async () => {
    try {
      const next = await invoke<OllamaInstallStatus>("get_ollama_install_status");
      setInstallStatus(next);
    } catch (error) {
      console.warn("[OllamaLocalManager] 恢复安装状态失败", error);
    }
  }, []);

  const hydratePullProgress = useCallback(async () => {
    try {
      const progressList = await invoke<OllamaPullProgressEvent[]>("list_ollama_pull_progress");
      const nextMap: Record<string, OllamaPullProgressEvent> = {};
      let activeModel: string | null = null;

      for (const item of progressList) {
        nextMap[item.model] = item;
        if (!item.done && !activeModel) {
          activeModel = item.model;
        }
      }

      setDownloadProgress(nextMap);
      setDownloadingModel(activeModel);
    } catch (error) {
      console.warn("[OllamaLocalManager] 恢复下载状态失败", error);
    }
  }, []);

  useEffect(() => {
    refreshData(false);
    hydratePullProgress();
    hydrateInstallStatus();
  }, [hydrateInstallStatus, hydratePullProgress, refreshData]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<OllamaPullProgressEvent>("ollama-pull-progress", (event) => {
        if (disposed) return;
        const payload = event.payload;
        setDownloadProgress((prev) => ({
          ...prev,
          [payload.model]: payload,
        }));
        setDownloadingModel(payload.done ? null : payload.model);
      });
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!installStatus?.done || installStatus?.error) return;
    refreshData(false).catch((error) => {
      console.warn("[OllamaLocalManager] 安装完成后刷新状态失败", error);
    });
  }, [installStatus?.done, installStatus?.error, refreshData]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<OllamaInstallStatus>("ollama-install-status", (event) => {
        if (disposed) return;
        setInstallStatus(event.payload);
      });
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const installedNames = useMemo(() => new Set(installedModels.map((item) => item.name)), [installedModels]);

  const copyText = useCallback(async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message, { description: text });
    } catch (error) {
      toast.error("复制失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const handleDownload = useCallback(async (modelName: string) => {
    const baseUrl = status?.baseUrl || providerBaseUrl;
    setDownloadingModel(modelName);
    setDownloadProgress((prev) => ({
      ...prev,
      [modelName]: {
        model: modelName,
        status: "准备下载",
        percent: 0,
        done: false,
      },
    }));
    try {
      const result = await invoke<string>("pull_ollama_model", { baseUrl, model: modelName });
      if (result === "模型下载已取消") {
        toast.message("模型下载已取消", { description: modelName });
      } else {
        setInstalledModelsList((prev) => {
          if (prev.some((item) => item.name === modelName)) return prev;
          return [{ name: modelName, modifiedAt: new Date().toISOString() }, ...prev];
        });
        setOllamaModels(Array.from(new Set([modelName, ...installedModels.map((item) => item.name)])));
        toast.success("模型下载完成", { description: `${modelName} · ${result}` });
      }
      await refreshData(false);
      if (result !== "模型下载已取消") {
        setTimeout(() => {
          refreshData(false).catch((error) => {
            console.warn("[OllamaLocalManager] 延迟刷新已安装模型失败", error);
          });
        }, 1200);
      }
      await hydratePullProgress();
    } catch (error) {
      toast.error("模型下载失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDownloadingModel(null);
      setTimeout(() => {
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[modelName];
          return next;
        });
      }, 1200);
    }
  }, [hydratePullProgress, installedModels, providerBaseUrl, refreshData, setOllamaModels, status?.baseUrl]);

  const handleCancelDownload = useCallback(async (modelName: string) => {
    try {
      await invoke("cancel_ollama_pull", { model: modelName });
      setDownloadProgress((prev) => ({
        ...prev,
        [modelName]: {
          model: modelName,
          status: CANCELED_STATUS,
          done: true,
        },
      }));
      toast.message("已请求取消下载", { description: modelName });
    } catch (error) {
      toast.error("取消下载失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleDelete = useCallback(async (modelName: string) => {
    const baseUrl = status?.baseUrl || providerBaseUrl;
    setDeletingModel(modelName);
    try {
      const result = await invoke<string>("delete_ollama_model", { baseUrl, model: modelName });
      setInstalledModelsList((prev) => prev.filter((item) => item.name !== modelName));
      setOllamaModels(installedModels.filter((item) => item.name !== modelName).map((item) => item.name));
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelName];
        return next;
      });
      toast.success("模型已删除", { description: `${modelName} · ${result}` });
      setPendingDeleteModel(null);
      await refreshData(false);
      await hydratePullProgress();
    } catch (error) {
      toast.error("删除模型失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeletingModel(null);
    }
  }, [hydratePullProgress, installedModels, providerBaseUrl, refreshData, setOllamaModels, status?.baseUrl]);

  const handleStartService = useCallback(async () => {
    const baseUrl = status?.baseUrl || providerBaseUrl;
    setServiceAction("starting");
    try {
      const result = await invoke<string>("start_ollama_service", { baseUrl });
      toast.success("Ollama 服务启动完成", { description: result });
      await refreshData(false);
    } catch (error) {
      toast.error("启动 Ollama 服务失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setServiceAction(null);
    }
  }, [providerBaseUrl, refreshData, status?.baseUrl]);

  const handleInstallOllama = useCallback(async () => {
    try {
      const result = await invoke<string>("install_ollama");
      setInstallDialogOpen(true);
      toast.success("已开始安装 Ollama", { description: result });
      await hydrateInstallStatus();
    } catch (error) {
      toast.error("启动安装失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [hydrateInstallStatus]);

  const canDownload = !!status?.installed && !!status?.running;

  return (
    <>
      <Card className="border-slate-200/80 bg-white/90 shadow-sm dark:border-slate-700/80 dark:bg-slate-900/90">
        <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-xl text-slate-900 dark:text-slate-100">
              <HardDrive className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              本地模型管理
            </CardTitle>
            <CardDescription>
              检测 `ollama` 安装和服务状态，查看本机模型并直接下载推荐模型。
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshData(true)}
            disabled={refreshing}
            className="gap-2"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新状态
          </Button>
        </div>
      </CardHeader>

        <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-700/80 dark:bg-slate-950/40">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <Server className="h-4 w-4" />
              安装状态
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                检测中
              </div>
            ) : status?.installed ? (
              <div className="space-y-2">
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
                  已安装
                </Badge>
                <p className="text-xs text-slate-500 dark:text-slate-400">{status.version || "未读取到版本信息"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Badge variant="secondary">未安装</Badge>
                <p className="text-xs text-slate-500 dark:text-slate-400">未在系统 PATH 或常见安装位置找到 `ollama`。</p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-700/80 dark:bg-slate-950/40">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <CheckCircle2 className="h-4 w-4" />
              服务状态
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                检测中
              </div>
            ) : status?.running ? (
              <div className="space-y-2">
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
                  运行中
                </Badge>
                <p className="text-xs text-slate-500 dark:text-slate-400">{status.baseUrl}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Badge variant="secondary">未启动</Badge>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {status?.error || "本地 API 未响应，请启动 Ollama 桌面应用或执行启动命令。"}
                </p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-700/80 dark:bg-slate-950/40">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <Download className="h-4 w-4" />
              快捷操作
            </div>
            <div className="flex flex-wrap gap-2">
              {!status?.installed && (
                <Button size="sm" className="gap-2" disabled={!!installStatus?.running} onClick={handleInstallOllama}>
                  {installStatus?.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  一键安装
                </Button>
              )}
              {!status?.installed && (
                <Button variant="outline" size="sm" className="gap-2" onClick={() => linkOpener.openLink(status?.installUrl || "https://ollama.com/download")}>
                  <ExternalLink className="h-4 w-4" />
                  前往安装
                </Button>
              )}
              {(!!installStatus?.running || !!installStatus?.logs?.length) && (
                <Button variant="outline" size="sm" className="gap-2" onClick={() => setInstallDialogOpen(true)}>
                  <Logs className="h-4 w-4" />
                  查看日志
                </Button>
              )}
              {!!status?.startCommand && status.installed && !status.running && (
                <Button size="sm" className="gap-2" disabled={serviceAction !== null} onClick={handleStartService}>
                  {serviceAction === "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  启动服务
                </Button>
              )}
              {!!status?.startCommand && status.installed && !status.running && (
                <Button variant="outline" size="sm" className="gap-2" onClick={() => copyText(status.startCommand!, "已复制启动命令")}>
                  <Copy className="h-4 w-4" />
                  复制启动命令
                </Button>
              )}
              {!!status?.commandPath && status.installed && (
                <Button variant="ghost" size="sm" className="gap-2 text-xs" onClick={() => copyText(status.commandPath!, "已复制 Ollama 路径")}>
                  <Copy className="h-3.5 w-3.5" />
                  复制路径
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)]">
          <section className="rounded-xl border border-slate-200/80 p-4 dark:border-slate-700/80">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">已安装模型</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">当前从本机 Ollama 服务读取。</p>
              </div>
              <Badge variant="outline">{installedModels.length} 个</Badge>
            </div>

            {!status?.running ? (
              <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-slate-200/80 bg-slate-50/60 px-4 text-center text-sm text-slate-500 dark:border-slate-700/80 dark:bg-slate-950/30 dark:text-slate-400">
                启动 Ollama 后会在这里显示已下载模型。
              </div>
            ) : installedModels.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-slate-200/80 bg-slate-50/60 px-4 text-center text-sm text-slate-500 dark:border-slate-700/80 dark:bg-slate-950/30 dark:text-slate-400">
                当前还没有本地模型，可以从右侧列表直接下载。
              </div>
            ) : (
              <div className="space-y-2">
                {installedModels.map((model) => (
                  <div
                    key={model.name}
                    className="rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-700/80 dark:bg-slate-950/30"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{model.name}</div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {formatBytes(model.size)} · {formatTime(model.modifiedAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className="shrink-0 bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
                          已就绪
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                          disabled={deletingModel !== null}
                          onClick={() => setPendingDeleteModel(model.name)}
                        >
                          {deletingModel === model.name ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          删除
                        </Button>
                      </div>
                    </div>
                    {deletingModel === model.name && (
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">正在删除并刷新列表...</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200/80 p-4 dark:border-slate-700/80">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">可下载模型</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  仅提供预设的 Gemma 4 模型。未启动 Ollama 时下载按钮会禁用。
                </p>
              </div>
              {!canDownload && (
                <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <CircleAlert className="h-3.5 w-3.5" />
                  需要先启动 Ollama
                </div>
              )}
            </div>

            <div className="grid gap-2">
              {RECOMMENDED_MODELS.map((item) => {
                const isInstalled = installedNames.has(item.name);
                const isDownloading = downloadingModel === item.name;
                const progress = downloadProgress[item.name];

                return (
                  <div
                    key={item.name}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      isInstalled
                        ? "border-green-200 bg-green-50/60 dark:border-green-800/70 dark:bg-green-950/20"
                        : "border-slate-200/80 bg-slate-50/70 dark:border-slate-700/80 dark:bg-slate-950/30"
                    )}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</h4>
                            <Badge variant="outline">{item.size}</Badge>
                            {isInstalled && (
                              <Badge className="bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
                                已安装
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.description}</p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {item.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{item.name}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isDownloading && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-2"
                            onClick={() => handleCancelDownload(item.name)}
                          >
                            取消
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="gap-2"
                          disabled={!canDownload || isInstalled || (downloadingModel !== null && !isDownloading)}
                          onClick={() => handleDownload(item.name)}
                        >
                          {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          {isInstalled ? "已安装" : "下载"}
                        </Button>
                      </div>
                    </div>
                    {progress && (
                      <div className="mt-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                          <span className="truncate">{progress.status}</span>
                          <span>
                            {progress.status === CANCELED_STATUS
                              ? "已取消"
                              : typeof progress.percent === "number"
                                ? `${Math.round(progress.percent)}%`
                                : "处理中"}
                          </span>
                        </div>
                        <Progress
                          value={progress.status === CANCELED_STATUS ? 0 : typeof progress.percent === "number" ? progress.percent : 10}
                          className="h-2"
                        />
                        {typeof progress.completed === "number" && typeof progress.total === "number" && progress.total > 0 && (
                          <div className="text-[11px] text-slate-400 dark:text-slate-500">
                            {formatBytes(progress.completed)} / {formatBytes(progress.total)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!pendingDeleteModel} onOpenChange={(open) => !open && setPendingDeleteModel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该 Ollama 模型？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteModel ? `这会从本机 Ollama 中移除 ${pendingDeleteModel}。` : "这会从本机 Ollama 中移除该模型。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingModel !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (pendingDeleteModel) {
                  handleDelete(pendingDeleteModel);
                }
              }}
              disabled={deletingModel !== null}
            >
              {deletingModel ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ollama 安装日志</DialogTitle>
            <DialogDescription>
              {installStatus?.running
                ? `正在执行：${installStatus.phase || "安装中"}`
                : installStatus?.error
                  ? "安装失败，请查看日志。"
                  : installStatus?.done
                    ? "安装已完成。"
                    : "等待开始安装。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
                <span>{installStatus?.phase || "未开始"}</span>
                <span>{Math.round(installStatus?.progress || 0)}%</span>
              </div>
              <Progress value={installStatus?.progress || 0} className="h-2" />
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-slate-200/80 bg-slate-950 p-3 text-xs text-slate-100">
              <pre className="whitespace-pre-wrap break-words font-mono">
                {(installStatus?.logs && installStatus.logs.length > 0)
                  ? installStatus.logs.join("\n")
                  : "暂无日志"}
                {installStatus?.error ? `\n\nERROR: ${installStatus.error}` : ""}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
