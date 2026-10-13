// load-env.ts — 最小 .env 加载器（各入口共用）
//
// 不用 dotenv 包，是为了绕开外部注入旧键（AGENTMEMORY_*）的钩子。
// 语义：逐行读 KEY=VALUE；**值为空的行被跳过** —— 因此可以用环境变量注入密钥，
// 而 .env 里把该键留空即可（这正是本项目对 DEEPSEEK_API_KEY 的处理方式）。
//
// 从 src/ 或 dist/ 调用都指向仓库根目录下的 .env。

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 读取 .env 并写入 process.env。返回实际读取到的路径；不存在则返回 null。 */
export function loadEnvFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../.env");
  if (!existsSync(envPath)) return null;

  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    // 空值跳过：让环境变量成为密钥的注入通道
    if (k && v) process.env[k] = v;
  }
  return envPath;
}
