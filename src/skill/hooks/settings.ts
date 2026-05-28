// Shared settings loader — used by hooks to read API keys from Claude settings.
import * as fs from "node:fs";

export function loadSettingsEnv(): Record<string, string> {
  const settingsPaths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const p of settingsPaths) {
    try {
      const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (obj.env) Object.assign(env, obj.env);
    } catch {}
  }
  return env;
}
