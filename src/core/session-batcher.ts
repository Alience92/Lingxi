// session-batcher.ts — 会话消息攒批器（宿主无关）
//
// 为什么放在 core 而不是适配层（P6.4）：
//   「攒够 N 条消息再落库」是**记忆系统的策略**，不是某个宿主的职责。
//   把它留在 dsh-adapter 里会导致：换一个宿主就要重写一遍同样的策略，
//   且策略无法被单测覆盖（adapter 依赖宿主私有包，本仓库跑不起来）。
//
// 本模块不依赖任何宿主、不依赖 DB，只做纯粹的攒批状态机，因此可直接单测。

export interface SessionBatcherOptions {
  /** 攒够多少条消息触发一次 flush（默认 8） */
  batchSize?: number;
  /** 拼接批次内消息的分隔符（默认换行） */
  joinWith?: string;
  /** 达到批次时收到的完整 transcript。抛错由调用方决定如何处理 */
  flush: (transcript: string) => void | Promise<void>;
}

export interface SessionBatcher {
  /**
   * 投入一条消息。空白消息被忽略。
   * 返回 true 表示本次调用触发了 flush（此时缓冲已清空）。
   */
  push(content: string): Promise<boolean>;
  /** 取出并清空当前缓冲；为空返回 null。用于会话结束时的收尾 flush。 */
  drain(): string | null;
  /** 当前缓冲中的消息条数 */
  size(): number;
}

/** 默认批大小：8 条消息约等于一小段完整对话，过小会产生碎片、过大则延迟落库。 */
export const DEFAULT_BATCH_SIZE = 8;

export function createSessionBatcher(opts: SessionBatcherOptions): SessionBatcher {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize 必须是 >= 1 的整数，收到：${batchSize}`);
  }
  const joinWith = opts.joinWith ?? "\n";

  let buffer: string[] = [];

  return {
    async push(content: string): Promise<boolean> {
      if (typeof content !== "string" || content.trim() === "") return false;
      buffer.push(content);
      if (buffer.length < batchSize) return false;

      // 先清空再 flush：与原实现一致 —— flush 失败也不重放，避免失败时无限增长。
      // 调用方需自行决定是否吞掉异常（宿主侧通常选择不阻塞会话）。
      const transcript = buffer.join(joinWith);
      buffer = [];
      await opts.flush(transcript);
      return true;
    },

    drain(): string | null {
      if (buffer.length === 0) return null;
      const transcript = buffer.join(joinWith);
      buffer = [];
      return transcript;
    },

    size(): number {
      return buffer.length;
    },
  };
}
