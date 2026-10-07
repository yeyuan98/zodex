import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// specs/agent-runtimes.md §5（alpha.1 S1/S2 技能修正）不变量钉测：
// 钉不变量而非逐字（[ulw] m4 折叠）。alpha.0 版 S2/S1 教了假等价
// （「Four files are read and merged」不成立 + 「两腿等价、优先 `.agents`」+
// isolation「carried on the .agents leg」），正是 rig §2m 事故路径——
// W2 修正技能文案后本组转绿。
//
// 不变量：
//   (1) S2 的 MCP 配置节必须陈述同名冲突规则（同 scope `.zcode` 胜出 +
//       user 遮蔽 project = S1 事故模式明说）；
//   (2) S2/S1 不得有任何「isolation 被文件腿（.agents/.zcode）接受/携带」表述
//       （两条文件腿 strict schema 均不接受，仅协议形状携带——spec §5 字段表）；
//   (3) S1 接线节（Step 9）必须携带同名冲突注记。

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, "apps/zcode-cli/packages/bundled-skills/skills");

function readSkill(relativePath: string): Promise<string> {
  return readFile(join(SKILLS_DIR, relativePath), "utf8");
}

/** 提取 `## MCP server configuration` 节（到下一个 `## ` 为止）——冲突规则必须落在 MCP 节，防 Skills 节的既有 Same-name 句误命中。 */
function extractMcpConfigSection(text: string): string {
  const start = text.indexOf("## MCP server configuration");
  assert.ok(start >= 0, "前置：S2 必须保留 MCP server configuration 节");
  const next = text.indexOf("\n## ", start);
  return text.slice(start, next >= 0 ? next : undefined);
}

/** 在指定文本里找「同名冲突规则」段：须同时点名 same-name 冲突、`.zcode` 腿与 user 级遮蔽。 */
function findSameNameConflictParagraph(section: string): string | undefined {
  return section
    .split(/\n\s*\n/)
    .find(
      (paragraph) =>
        /same[- ]name|same name|conflict/i.test(paragraph) &&
        /\.zcode/.test(paragraph) &&
        /\.agents/.test(paragraph) &&
        /user/i.test(paragraph),
    );
}

test("技能不变量：S2 MCP 配置节陈述同名冲突规则（同 scope `.zcode` 胜出 + user 遮蔽 project）（今日红：alpha.0 无冲突规则）", async () => {
  const text = await readSkill("zcode-config-reference/SKILL.md");
  const section = extractMcpConfigSection(text);
  const paragraph = findSameNameConflictParagraph(section);
  assert.ok(
    paragraph !== undefined,
    "S2 的 MCP 配置节必须有一个同名冲突规则段：提及 same-name 冲突、两条文件腿（.zcode/.agents）与 user 级遮蔽（spec §5：S1 事故模式明说）",
  );
  assert.match(paragraph, /user[^\n]*(project|workspace)|(project|workspace)[^\n]*user/i);
});

test("技能不变量：S2/S1 无「isolation 被文件腿接受/携带」表述（今日红：S2 称 carried on the .agents leg）", async () => {
  const files = [
    "zcode-config-reference/SKILL.md",
    "zcode-workspace-runtimes/SKILL.md",
    "zcode-workspace-runtimes/patterns.md",
    "zcode-workspace-runtimes/examples.md",
  ];
  // 「接受/携带/保留在文件腿」类动词 + `.agents`/文件腿语境 = 违规表述。
  const acceptancePattern =
    /(carried|accept|accepted|keep it|supported|honor)[^\n]*\.(agents|zcode)|\.(agents|zcode)[^\n]*(carries|accepts|supports)[^\n]*isolation/i;
  for (const relativePath of files) {
    const text = await readSkill(relativePath);
    const offendingLines = text
      .split(/\r?\n/)
      .filter((line) => /isolation/i.test(line) && acceptancePattern.test(line));
    assert.deepEqual(
      offendingLines,
      [],
      `${relativePath} 不得声称 isolation 被文件腿接受（两条文件腿 strict schema 均不接受，仅协议形状携带——写入任一文件 = 整 server 丢警告，spec §5.2）`,
    );
  }
});

test("技能不变量：S1 接线节（Step 9）携带同名冲突注记（今日红：仅「and/or」无冲突语义）", async () => {
  const text = await readSkill("zcode-workspace-runtimes/SKILL.md");
  const start = text.indexOf("## Step 9");
  assert.ok(start >= 0, "前置：S1 必须保留 Step 9 接线节");
  const next = text.indexOf("\n## ", start);
  const section = text.slice(start, next >= 0 ? next : undefined);
  const paragraph = findSameNameConflictParagraph(section);
  assert.ok(
    paragraph !== undefined,
    "S1 Step 9 接线节必须携带同名冲突注记：提及 same-name 冲突、两条文件腿（.zcode/.agents）与 user 级遮蔽（spec §4.5）",
  );
});
