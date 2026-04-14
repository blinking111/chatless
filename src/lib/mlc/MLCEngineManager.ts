'use client';

import type { MLCEngine } from '@mlc-ai/web-llm';
import { buildMLCAppConfig } from './config';

type InitProgress = {
  progress?: number;
  text?: string;
  timeElapsed?: number;
};

type EnsureOptions = {
  onProgress?: (progress: InitProgress) => void;
};

class MLCEngineManager {
  private engine: MLCEngine | null = null;
  private currentModelId: string | null = null;
  private loadPromise: Promise<MLCEngine> | null = null;

  async checkSupport(): Promise<{ ok: boolean; message?: string }> {
    if (typeof window === 'undefined') {
      console.warn('[MLC-LLM] support check failed: no window');
      return { ok: false, message: '当前环境不支持 MLC-LLM' };
    }
    if (!('gpu' in navigator)) {
      console.warn('[MLC-LLM] support check failed: no WebGPU');
      return { ok: false, message: '当前 WebView 不支持 WebGPU，MLC-LLM 无法运行' };
    }
    console.log('[MLC-LLM] support check passed');
    return { ok: true, message: 'WebGPU 可用' };
  }

  interrupt(): void {
    try {
      console.log('[MLC-LLM] interrupt requested');
      this.engine?.interruptGenerate();
    } catch {
      // noop
    }
  }

  async unload(): Promise<void> {
    try {
      console.log('[MLC-LLM] unload engine');
      await this.engine?.unload();
    } catch {
      // noop
    }
    this.engine = null;
    this.currentModelId = null;
    this.loadPromise = null;
  }

  async ensureEngine(modelId: string, options: EnsureOptions = {}): Promise<MLCEngine> {
    const support = await this.checkSupport();
    if (!support.ok) {
      throw new Error(support.message || 'MLC-LLM 当前不可用');
    }

    if (this.engine && this.currentModelId === modelId) {
      console.log('[MLC-LLM] reuse loaded engine', { modelId });
      return this.engine;
    }
    if (this.loadPromise) {
      console.log('[MLC-LLM] await inflight engine load', { modelId, currentModelId: this.currentModelId });
      return this.loadPromise;
    }

    console.log('[MLC-LLM] ensure engine start', { modelId, currentModelId: this.currentModelId });
    const task = this.loadEngine(modelId, options).finally(() => {
      console.log('[MLC-LLM] ensure engine settled', { modelId });
      this.loadPromise = null;
    });
    this.loadPromise = task;
    return task;
  }

  private async loadEngine(modelId: string, options: EnsureOptions): Promise<MLCEngine> {
    const startedAt = Date.now();
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    const { appConfig, bundled } = await buildMLCAppConfig(modelId);
    const initProgressCallback = (report: InitProgress) => {
      options.onProgress?.(report);
      const ratio = typeof report.progress === 'number' ? `${Math.round(report.progress * 100)}%` : '';
      console.log(`[MLC-LLM] ${bundled ? 'bundled' : 'prebuilt'} ${modelId} ${ratio} ${report.text || ''}`.trim());
    };

    if (!this.engine) {
      console.log('[MLC-LLM] create engine and load model', { modelId, bundled });
      this.engine = await CreateMLCEngine(modelId, {
        appConfig,
        initProgressCallback,
      });
    } else {
      console.log('[MLC-LLM] reload engine with model', { modelId, bundled, previousModelId: this.currentModelId });
      this.engine.setInitProgressCallback(initProgressCallback);
      this.engine.setAppConfig(appConfig);
      await this.engine.reload(modelId);
    }
    this.currentModelId = modelId;
    console.log('[MLC-LLM] engine ready', { modelId, bundled, elapsedMs: Date.now() - startedAt });
    return this.engine;
  }
}

export const mlcEngineManager = new MLCEngineManager();
