import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// specs/agent-runtimes.md §6（bundled skills 四清单 + 钉测）红测：
// bundled skills 的 required-asset 门有四份同步清单（bootstrap / SEA 构建 /
// prepare-prebuilds / prepare-agent-node-bundle），此前无任何测试钉住——
// dynamic-workflows 单技能时期无漂移风险，三个技能起「新技能漏改某条分发链」
// 成为真实回归面。本钉测的不变量：
//   (a) 四清单每个都覆盖全部 bundled 技能（技能名 + 必需资产文件名出现在清单文件里；
//       形状自由——bootstrap 对 dynamic-workflows 用 DYNAMIC_WORKFLOW_SKILL_NAME
//       常量拼接，其余三处为字面量路径，钉测两者都接受）；
//   (b) 磁盘上 skills/ 每个技能目录都有 SKILL.md；
//   (c) 每个 SKILL.md frontmatter：name 非空 + description ≤1024 字符
//       （adapters/src/skills/index.ts:20-27 契约，SAFE_FRONTMATTER_KEYS 同源）。
// 今日（W3 前）zcode-workspace-runtimes / zcode-config-reference 不存在 ⇒ (a)(b) 红；
// dynamic-workflows 的 (b)(c) 今绿且必须保持绿。

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, "apps/zcode-cli/packages/bundled-skills/skills");

/** 四份 required-asset 门清单（形状各异：TS 常量数组 ×1 + mjs 字面量数组 ×3）。 */
const GATE_LIST_FILES = [
  "apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts",
  "apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs",
  "scripts/prepare-prebuilds.mjs",
  "packages/desktop/scripts/prepare-agent-node-bundle.mjs",
] as const;

/** 每个 bundled 技能的必需资产（spec §6：S1 沿 dynamic-workflows 三件套，S2 纯文档单文件）。 */
const REQUIRED_SKILLS: Array<{ name: string; assets: string[]; nameAliases: string[] }> = [
  {
    name: "dynamic-workflows",
    assets: ["SKILL.md", "patterns.md", "examples.md"],
    // bootstrap 清单用 DYNAMIC_WORKFLOW_SKILL_NAME 常量拼接路径——名字以常量或字面量出现皆可。
    nameAliases: ["DYNAMIC_WORKFLOW"],
  },
  {
    name: "zcode-workspace-runtimes",
    assets: ["SKILL.md", "patterns.md", "examples.md"],
    nameAliases: [],
  },
  {
    name: "zcode-config-reference",
    assets: ["SKILL.md"],
    nameAliases: [],
  },
];

test("bundledSkillsPin：四份 required-asset 门清单覆盖全部三个技能（今日红：两个新技能缺席）", async () => {
  for (const gateFile of GATE_LIST_FILES) {
    const text = await readFile(join(REPO_ROOT, gateFile), "utf8");
    for (const skill of REQUIRED_SKILLS) {
      const nameMentioned =
        text.includes(skill.name) || skill.nameAliases.some((alias) => text.includes(alias));
      assert.ok(
        nameMentioned,
        `${gateFile} 必须提及技能 ${skill.name}（漏改该分发链 ⇒ 技能文件在该形态下缺失，spec §6 不变量）`,
      );
      for (const asset of skill.assets) {
        assert.ok(
          text.includes(asset),
          `${gateFile} 必须把 ${skill.name} 的必需资产 ${asset} 列入 required-asset 门`,
        );
      }
    }
  }
});

test("bundledSkillsPin：磁盘 skills 目录 ⊇ 三个技能且每个目录有 SKILL.md（今日红：两个新目录不存在）", async () => {
  const dirNames = (await readdir(SKILLS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const skill of REQUIRED_SKILLS) {
    assert.ok(
      dirNames.includes(skill.name),
      `apps/zcode-cli/packages/bundled-skills/skills/ 下必须存在 ${skill.name} 目录`,
    );
  }
  for (const dirName of dirNames) {
    const skillDir = join(SKILLS_DIR, dirName);
    const files = await readdir(skillDir);
    assert.ok(files.includes("SKILL.md"), `技能目录 ${dirName} 必须包含 SKILL.md（技能发现入口）`);
  }
});

test("bundledSkillsPin：每个 SKILL.md frontmatter 有非空 name + description ≤1024 字符", async () => {
  // 行级解析（dynamic-workflows 与两个新技能的 frontmatter 均为单行键值）；
  // 若未来出现折叠多行 description，解析会因取不到值而响亮失败——届时再升级解析器。
  const dirNames = (await readdir(SKILLS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(dirNames.length > 0, "前置：skills 目录非空");
  for (const dirName of dirNames) {
    const content = await readFile(join(SKILLS_DIR, dirName, "SKILL.md"), "utf8");
    const lines = content.split(/\r?\n/);
    assert.equal(lines[0], "---", `${dirName}/SKILL.md 必须以 frontmatter 围栏开头`);
    const fenceEnd = lines.indexOf("---", 1);
    assert.ok(fenceEnd > 1, `${dirName}/SKILL.md frontmatter 必须闭合`);
    const frontmatter = new Map<string, string>();
    for (const line of lines.slice(1, fenceEnd)) {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (match) {
        frontmatter.set(match[1]!, match[2]!.trim().replace(/^["']|["']$/g, ""));
      }
    }
    const name = frontmatter.get("name") ?? "";
    assert.ok(name.length > 0, `${dirName}/SKILL.md frontmatter name 必须非空`);
    const description = frontmatter.get("description") ?? "";
    assert.ok(
      description.length > 0,
      `${dirName}/SKILL.md frontmatter description 必须非空（存在 frontmatter 时必填）`,
    );
    assert.ok(
      description.length <= 1024,
      `${dirName}/SKILL.md description 必须 ≤1024 字符（实际 ${description.length}；adapters MAX_DESCRIPTION_LENGTH 契约）`,
    );
  }
});
