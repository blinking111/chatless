import type { AppConfig, ModelRecord } from '@mlc-ai/web-llm';

export const MLC_PROVIDER_NAME = 'MLC-LLM';
export const MLC_BUNDLED_DEFAULT_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

const MLC_BUNDLED_MODEL_ROOT = '/mlc-llm/models';
const MLC_BUNDLED_LIB_ROOT = '/mlc-llm/libs';

type WebLLMModule = typeof import('@mlc-ai/web-llm');

function extractFileName(url: string): string {
  const clean = String(url || '').split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || '';
}

async function resolvePrebuiltModelRecord(modelId: string): Promise<ModelRecord | null> {
  const webllm: WebLLMModule = await import('@mlc-ai/web-llm');
  return webllm.prebuiltAppConfig.model_list.find((item) => item.model_id === modelId) || null;
}

async function canUseBundledAssets(record: ModelRecord): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const wasmFile = extractFileName(record.model_lib);
  if (!wasmFile) return false;
  try {
    const [configResp, wasmResp] = await Promise.all([
      fetch(`${MLC_BUNDLED_MODEL_ROOT}/${record.model_id}/mlc-chat-config.json`, { method: 'HEAD' }),
      fetch(`${MLC_BUNDLED_LIB_ROOT}/${wasmFile}`, { method: 'HEAD' }),
    ]);
    const ok = configResp.ok && wasmResp.ok;
    console.log('[MLC-LLM] bundled asset probe', {
      modelId: record.model_id,
      configOk: configResp.ok,
      wasmOk: wasmResp.ok,
      bundled: ok,
    });
    return ok;
  } catch {
    console.warn('[MLC-LLM] bundled asset probe failed', { modelId: record.model_id });
    return false;
  }
}

function toBundledRecord(record: ModelRecord): ModelRecord {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const wasmFile = extractFileName(record.model_lib);
  return {
    ...record,
    // WebLLM 会强制把 model URL 规范成带 /resolve/main/ 的 Hugging Face 风格地址。
    // 这里手动塞入一个可被其正则识别、但在 URL 规范化后仍回到真实本地目录的绝对路径。
    model: `${origin}${MLC_BUNDLED_MODEL_ROOT}/${record.model_id}/resolve/main/../../`,
    model_lib: `${origin}${MLC_BUNDLED_LIB_ROOT}/${wasmFile}`,
  };
}

export async function buildMLCAppConfig(modelId: string): Promise<{ appConfig: AppConfig; bundled: boolean }> {
  const record = await resolvePrebuiltModelRecord(modelId);
  if (!record) {
    throw new Error(`MLC 预置模型不存在: ${modelId}`);
  }

  const bundled = await canUseBundledAssets(record);
  console.log('[MLC-LLM] build app config', {
    modelId,
    bundled,
    model: bundled ? toBundledRecord(record).model : record.model,
    modelLib: bundled ? toBundledRecord(record).model_lib : record.model_lib,
  });
  return {
    appConfig: {
      model_list: [bundled ? toBundledRecord(record) : record],
      useIndexedDBCache: true,
    },
    bundled,
  };
}
