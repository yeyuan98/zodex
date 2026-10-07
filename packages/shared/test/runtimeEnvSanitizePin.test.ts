import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeZCodeRuntimeEnv } from "../src/runtimeEnv.ts";

// specs/agent-runtimes.md §2.5（镜像缺省填空）钉测：C3 的镜像缺省填空依赖
// 「sanitizeZCodeRuntimeEnv 不剥 npm_config_registry 与 UV_*（仅剥 *_proxy/cafile/ca
// 族）」这一既有事实——钉为单测事实，防未来 sanitize 扩名单悄悄破坏用户偏好
// （alpha2-plan §1.2：此前全仓无测试覆盖）。
//
// 红位说明：`pnpm_config_ca` 按族语义（`*ca`）应被剥，但现行模式
// `/^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i`
// 的 `pnpm` 前缀只匹配 `pnpm_<suffix>` 形态、不覆盖 `pnpm_config_ca`——与 spec §2.5
// 「仅剥 *_proxy/cafile/ca 族」语义冲突（今日即红）；实现方扩展模式后转绿。
// 其余断言为今绿钉测（W5/W6 落地后必须保持绿）。

const SURVIVING_KEYS = [
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "UV_DEFAULT_INDEX",
  "UV_PYTHON_INSTALL_MIRROR",
] as const;

const STRIPPED_KEYS = ["npm_config_https_proxy", "yarn_cafile", "pnpm_config_ca"] as const;

test("sanitize 钉测：registry/UV_* 键（多大小写形态）不被剥（§2.5 填空依赖）", () => {
  const env: Record<string, string> = {};
  for (const key of SURVIVING_KEYS) env[key] = `value-of-${key}`;
  const sanitized = sanitizeZCodeRuntimeEnv(env);
  for (const key of SURVIVING_KEYS) {
    assert.equal(sanitized[key], `value-of-${key}`, `${key} 必须在 sanitize 后存活`);
  }
});

test("sanitize 钉测：*_proxy/cafile/ca 族仍被剥（含 pnpm_config_ca 形态——今日红：模式缺口）", () => {
  const env: Record<string, string> = {};
  for (const key of STRIPPED_KEYS) env[key] = `value-of-${key}`;
  const sanitized = sanitizeZCodeRuntimeEnv(env);
  for (const key of STRIPPED_KEYS) {
    assert.equal(sanitized[key], undefined, `${key} 属 *_proxy/cafile/ca 族，必须被 sanitize 剥除`);
  }
});
