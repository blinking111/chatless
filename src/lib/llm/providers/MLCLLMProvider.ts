import { getStaticModels } from '@/lib/provider/staticModels';
import { createStreamEvent } from '@/lib/llm/types/stream-events';
import type { ChatCompletionChunk } from '@mlc-ai/web-llm/lib/openai_api_protocols';
import { BaseProvider, type CheckResult, type LlmMessage, type StreamCallbacks } from './BaseProvider';
import { mlcEngineManager } from '@/lib/mlc/MLCEngineManager';

export class MLCLLMProvider extends BaseProvider {
  private aborted = false;

  constructor() {
    super('MLC-LLM', '');
  }

  async checkConnection(): Promise<CheckResult> {
    const support = await mlcEngineManager.checkSupport();
    console.log('[MLC-LLM] check connection', support);
    return support.ok
      ? { ok: true, message: support.message }
      : { ok: false, reason: 'UNKNOWN', message: support.message };
  }

  async fetchModels(): Promise<Array<{ name: string; label?: string; aliases?: string[] }> | null> {
    return getStaticModels('MLC-LLM').map((model) => ({
      name: model.id,
      label: model.label,
      aliases: [model.id],
    }));
  }

  async chatStream(
    model: string,
    messages: LlmMessage[],
    cb: StreamCallbacks,
    opts: Record<string, any> = {}
  ): Promise<void> {
    this.aborted = false;
    const startedAt = Date.now();
    let chunkCount = 0;
    let contentChars = 0;
    let firstChunkAt: number | null = null;
    console.log('[MLC-LLM] chat stream start', {
      model,
      messageCount: messages.length,
      options: {
        temperature: opts.temperature,
        topP: opts.topP,
        maxTokens: opts.maxTokens,
        maxOutputTokens: opts.maxOutputTokens,
        stop: opts.stop,
      },
    });
    cb.onStart?.();

    try {
      const engine = await mlcEngineManager.ensureEngine(model, {
        onProgress: (progress) => {
          console.log('[MLC-LLM] load progress', {
            model,
            progress: progress.progress,
            text: progress.text,
            timeElapsed: progress.timeElapsed,
          });
        },
      });
      console.log('[MLC-LLM] create chat completion stream', { model });
      const stream = await engine.chat.completions.create({
        messages: messages.map((message) => ({
          role: message.role as 'user' | 'assistant' | 'system',
          content: message.content,
        })),
        stream: true,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
        top_p: typeof opts.topP === 'number' ? opts.topP : undefined,
        max_tokens: typeof opts.maxTokens === 'number'
          ? opts.maxTokens
          : (typeof opts.maxOutputTokens === 'number' ? opts.maxOutputTokens : undefined),
        frequency_penalty: typeof opts.frequencyPenalty === 'number' ? opts.frequencyPenalty : undefined,
        presence_penalty: typeof opts.presencePenalty === 'number' ? opts.presencePenalty : undefined,
        stop: typeof opts.stop !== 'undefined' ? opts.stop : undefined,
      });

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (this.aborted) {
          console.warn('[MLC-LLM] stream aborted by user', { model, chunkCount });
          mlcEngineManager.interrupt();
          return;
        }
        chunkCount += 1;
        if (firstChunkAt === null) {
          firstChunkAt = Date.now();
          console.log('[MLC-LLM] first chunk received', {
            model,
            elapsedMs: firstChunkAt - startedAt,
          });
        }

        const delta = chunk.choices?.[0]?.delta as {
          content?: string | null;
          reasoning_content?: string | null;
        } | undefined;

        const reasoning = delta?.reasoning_content || '';
        if (reasoning) {
          if (cb.onEvent) {
            cb.onEvent(createStreamEvent.thinkingStart('standard'));
            cb.onEvent(createStreamEvent.thinkingToken(reasoning));
            cb.onEvent(createStreamEvent.thinkingEnd());
          } else {
            cb.onToken?.(`<think>${reasoning}</think>`);
          }
        }

        const content = delta?.content || '';
        if (!content) continue;
        contentChars += content.length;

        if (cb.onEvent) {
          cb.onEvent(createStreamEvent.contentToken(content));
        } else {
          cb.onToken?.(content);
        }
      }

      console.log('[MLC-LLM] stream complete', {
        model,
        chunkCount,
        contentChars,
        firstChunkDelayMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
        totalElapsedMs: Date.now() - startedAt,
      });
      if (cb.onEvent) {
        cb.onEvent(createStreamEvent.streamComplete());
      }
      cb.onComplete?.();
    } catch (error: any) {
      const message = error?.message || String(error);
      console.error('[MLC-LLM] stream error', {
        model,
        chunkCount,
        contentChars,
        elapsedMs: Date.now() - startedAt,
        message,
        error,
      });
      cb.onError?.(new Error(message));
    }
  }

  cancelStream(): void {
    this.aborted = true;
    console.log('[MLC-LLM] cancel stream');
    mlcEngineManager.interrupt();
  }

  async destroy(): Promise<void> {
    await mlcEngineManager.unload();
  }
}
