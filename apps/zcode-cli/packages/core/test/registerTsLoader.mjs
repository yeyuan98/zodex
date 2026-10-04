import { register } from "node:module";

// 注册 core 单测专用的 TS 说明符解析钩子；见 tsLoader.mjs 顶部说明
// （与 packages/bootstrap/test/registerTsLoader.mjs 同构，作用域为本包）。
register(new URL("./tsLoader.mjs", import.meta.url));
