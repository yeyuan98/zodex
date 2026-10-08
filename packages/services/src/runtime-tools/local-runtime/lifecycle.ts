/**
 * specs/agent-runtimes.md §4.6（生命周期矩阵 update/remove/test 行）：
 * checkUpdate（上游 latest vs pinned，可真实发现新版本——不随 app 版本）、
 * remove（删目录 + runtime.json pinned 清空 + CURRENT 随目录消除）、
 * reverify（--version 冒烟重跑）。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readCurrentPointer } from "./current.js";
import { readAppRuntimeJson, writeAppRuntimeJson } from "./runtime-json.js";
import { resolveLatestNodeVersion, resolveLatestUvVersion } from "./upstream.js";
import { smokeTestVersion } from "./download-verify.js";
import {
  fetchOptionsFor,
  resolveLogger,
  resolveRuntimeJsonPath,
  resolveRuntimeKindDir,
  type LocalRuntimeDeps,
  type LocalRuntimeKind,
  type LocalRuntimeReverifyResult,
  type LocalRuntimeUpdateCheck,
} from "./shared.js";

export async function checkUpdateRuntime(
  kind: LocalRuntimeKind,
  deps: LocalRuntimeDeps = {},
): Promise<LocalRuntimeUpdateCheck> {
  const logger = resolveLogger(deps);
  const json = readAppRuntimeJson(resolveRuntimeJsonPath(deps));
  const pinned = json?.pinned[kind] ?? "";
  const latest =
    kind === "node"
      ? await resolveLatestNodeVersion(fetchOptionsFor(deps))
      : await resolveLatestUvVersion(fetchOptionsFor(deps));
  const updateAvailable = pinned !== latest;
  logger.info(
    undefined,
    `check-update: kind=${kind} pinned=${pinned || "(none)"} latest=${latest} available=${updateAvailable}`,
  );
  return { kind, pinned, latest, updateAvailable };
}

export async function removeRuntime(
  kind: LocalRuntimeKind,
  deps: LocalRuntimeDeps = {},
): Promise<void> {
  const logger = resolveLogger(deps);
  const jsonPath = resolveRuntimeJsonPath(deps);
  const kindDir = resolveRuntimeKindDir(deps, kind);
  await rm(kindDir, { recursive: true, force: true });
  const json = readAppRuntimeJson(jsonPath);
  if (json) {
    writeAppRuntimeJson(jsonPath, { ...json, pinned: { ...json.pinned, [kind]: "" } });
  }
  logger.info(undefined, `remove done: kind=${kind}`);
}

export async function reverifyRuntime(
  kind: LocalRuntimeKind,
  deps: LocalRuntimeDeps = {},
): Promise<LocalRuntimeReverifyResult> {
  const logger = resolveLogger(deps);
  const kindDir = resolveRuntimeKindDir(deps, kind);
  const current = readCurrentPointer(kindDir);
  if (!current) {
    logger.warn(undefined, `reverify: kind=${kind} not installed (CURRENT absent)`);
    return { kind, ok: false, version: null, output: null };
  }
  try {
    const output = await smokeTestVersion(kind, join(kindDir, current), deps);
    logger.info(undefined, `reverify ok: kind=${kind} version=${current} output=${output}`);
    return { kind, ok: true, version: current, output };
  } catch (error) {
    logger.error(
      undefined,
      `reverify failed: kind=${kind} version=${current} error=${String(error)}`,
    );
    return { kind, ok: false, version: current, output: null };
  }
}
