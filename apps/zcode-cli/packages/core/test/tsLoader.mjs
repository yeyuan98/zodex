/**
 * core 单测的模块解析与加载钩子（node --test 直跑 CLI workspace 的 TS 源码）：
 *
 * 1. CLI workspace 源码内部一律用 `.js` 说明符引用 `.ts` 源文件（tsc/turbo 约定），
 *    Node 原生 resolver 不会做 `.js` → `.ts` 回映射；这里在目标 `.ts` 真实存在时重写。
 * 2. Node 原生类型剥离不做跨文件导入省略（接口与运行时值混在同一条 import 时，
 *    模块实例化会因 "does not provide an export named" 失败）；这里用 esbuild 按文件
 *    转换 TS（与应用构建器一致地带走仅类型导入），与 bootstrap 单测 tsLoader 同构。
 *
 * 依赖说明：esbuild 由 CLI workspace 根（apps/zcode-cli/node_modules）提供，
 * 从本文件位置向上解析即可命中；pnpm workspace 依赖经 node_modules 符号链接指向
 * 仓库 TS 源码，其 URL 仍带 /node_modules/，因此不能按路径排除，真实第三方依赖
 * 只发布 .js，按扩展名过滤即可只命中仓库 TS 源文件。
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { transform } from "esbuild";

function mapRelativeToExistingSource(specifier, parentPath) {
  if (!specifier.endsWith(".js")) {
    return null;
  }
  const parentDir = path.dirname(parentPath);
  const withoutExtension = specifier.slice(0, -3);
  const filePath = path.resolve(parentDir, `${withoutExtension}.ts`);
  return existsSync(filePath) ? filePath : null;
}

function isRepoTypeScriptSource(url) {
  if (!url.startsWith("file:")) {
    return false;
  }
  return /\.(ts|mts|tsx)$/.test(new URL(url).pathname);
}

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    typeof context.parentURL === "string" &&
    context.parentURL.startsWith("file:")
  ) {
    try {
      const parentPath = fileURLToPath(context.parentURL);
      const mapped = mapRelativeToExistingSource(specifier, parentPath);
      if (mapped) {
        return next(pathToFileURL(mapped).href, context);
      }
    } catch {
      // 非 file: parent（data:/node:）直接走默认解析。
    }
  }

  return next(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!isRepoTypeScriptSource(url) || result.source == null) {
    return result;
  }
  // Node 的默认 load 对文件返回 Buffer（而非 string），esbuild 两种都接受。
  const { code } = await transform(result.source, {
    loader: url.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
  });
  return { format: "module", source: code, shortCircuit: true };
}
