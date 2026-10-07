import assert from "node:assert/strict";
import test from "node:test";
import {
  settingsSyncDraftInvalidationReason,
  settingsSyncImportInvalidatesDraft,
} from "../src/lib/settingsSyncDraftInvalidation.ts";

// 覆盖 settings-sync 导入门扩展的纯谓词（specs/draft-session-invalidation.md §3：
// 门从 skills 单类扩为 skills|mcpServers|plugins）。说明：该谓词为 W2 新增逻辑，
// 此前门是内联的 category === "skills" 判断、无独立红测，故此处是落地即绿的
// 增量覆盖，不是红先行的回归测试。

test("settingsSyncImportInvalidatesDraft：能力类别（skills/mcpServers/plugins）→ true", () => {
  assert.equal(settingsSyncImportInvalidatesDraft(["skills"]), true);
  assert.equal(settingsSyncImportInvalidatesDraft(["mcpServers"]), true);
  assert.equal(settingsSyncImportInvalidatesDraft(["plugins"]), true);
  assert.equal(settingsSyncImportInvalidatesDraft(["commands", "mcpServers"]), true);
});

test("settingsSyncImportInvalidatesDraft：非能力类别与空集 → false", () => {
  assert.equal(settingsSyncImportInvalidatesDraft(["commands"]), false);
  assert.equal(settingsSyncImportInvalidatesDraft(["providers"]), false);
  assert.equal(settingsSyncImportInvalidatesDraft([]), false);
});

test("settingsSyncDraftInvalidationReason：类别 → 名词映射（kebab 对齐 settings-*- 家族）", () => {
  assert.equal(settingsSyncDraftInvalidationReason("skills"), "settings-sync-skill-import");
  assert.equal(settingsSyncDraftInvalidationReason("mcpServers"), "settings-sync-mcp-import");
  assert.equal(settingsSyncDraftInvalidationReason("plugins"), "settings-sync-plugin-import");
});
