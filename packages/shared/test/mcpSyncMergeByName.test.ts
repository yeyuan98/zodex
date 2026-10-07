import assert from "node:assert/strict";
import test from "node:test";
import { mergeDirectoryMcpRecordsByName } from "../src/mcp-sync.ts";

/**
 * specs/agent-runtimes.md §5.4（alpha.1）desktop 显示三位点共享纯函数契约：
 * 同 scope 双文件腿按「精确 server 名」合并——`.zcode` 同名胜出、`.agents` 独有名
 * 追加在后，合并键不做任何归一化。本测试钉住精确名不变量，防止未来
 * normalizeMcpNameKey 之类重构悄悄把大小写/下划线差异折叠成同一条目。
 */
interface NamedRecord {
  name: string;
  source: "zcode" | "agents";
}

test("同名精确匹配：`.zcode` 条目胜出，`.agents` 同名条目被丢弃", () => {
  const zcodeServer: NamedRecord = { name: "biomcp", source: "zcode" };
  const agentsServer: NamedRecord = { name: "biomcp", source: "agents" };
  const merged = mergeDirectoryMcpRecordsByName({
    zcodeServers: [zcodeServer],
    agentsServers: [agentsServer],
  });
  assert.deepEqual(merged, [zcodeServer], "同名时必须保留 `.zcode` 条目本身（引用不变）");
});

test("`.agents` 独有名条目追加在 `.zcode` 条目之后", () => {
  const zcodeOnly: NamedRecord = { name: "zcode-first", source: "zcode" };
  const shared: NamedRecord = { name: "shared", source: "zcode" };
  const agentsOnly: NamedRecord = { name: "agents-only", source: "agents" };
  const merged = mergeDirectoryMcpRecordsByName({
    zcodeServers: [zcodeOnly, shared],
    agentsServers: [{ name: "shared", source: "agents" }, agentsOnly],
  });
  assert.deepEqual(
    merged,
    [zcodeOnly, shared, agentsOnly],
    "合并顺序 = `.zcode` 条目在前、`.agents` 独有条目追加在后",
  );
});

test("精确键不变量：仅大小写或下划线不同的名字保持独立条目（不做归一化）", () => {
  const camelCase: NamedRecord = { name: "BioMCP", source: "zcode" };
  const lowerCase: NamedRecord = { name: "biomcp", source: "agents" };
  const snakeCase: NamedRecord = { name: "bio_mcp", source: "agents" };
  const merged = mergeDirectoryMcpRecordsByName({
    zcodeServers: [camelCase],
    agentsServers: [lowerCase, snakeCase],
  });
  assert.deepEqual(
    merged,
    [camelCase, lowerCase, snakeCase],
    "大小写（BioMCP vs biomcp）与下划线（bio_mcp vs biomcp）差异均不得折叠——合并键就是精确名字",
  );
});
