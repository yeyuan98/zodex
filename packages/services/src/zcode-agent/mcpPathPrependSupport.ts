import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesSchema,
  type ZCodeAgentMcpServer,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

// specs/agent-runtimes.md §2.4（C1 capability 门）：下行 strict schema 命中未知键会
// -32602 硬拒整次请求（session create/resume、mcp/list），因此 pathPrepend 必须
// capability-gated 下发——仅当连接的 CLI 上报 mcpPathPrepend:true 才携带；旧 CLI
// （flag falsy）或探测失败（fail-closed）时一律剥除。

const logger = createServiceLogger("zcode-agent-service");

// 沿 independentPlanSupport.ts 先例：per-client WeakMap 缓存，进程重启/换连接自然失效。
const capabilityChecks = new WeakMap<object, Promise<boolean>>();

/** 远端/捆绑 CLI 版本探测；失败按未支持处理（fail-closed）且不缓存失败结果。 */
export function supportsMcpPathPrepend(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<boolean> {
  const cached = capabilityChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((capabilities) => capabilities.mcpPathPrepend === true)
    .catch((cause: unknown) => {
      // fail-closed：探测失败等价于旧 CLI（不携带该字段），但删除缓存让下次调用重试，
      // 不把一次网络抖动固化为连接生命周期内的永久关闭。
      capabilityChecks.delete(client);
      logger.warn(
        undefined,
        "runtime/capabilities 探测失败，mcpServers.pathPrepend 按未支持处理（fail-closed）",
        {
          cause: cause instanceof Error ? cause.message : String(cause),
          method: zcodeProtocolMethods.runtimeCapabilities,
        },
      );
      return false;
    });
  capabilityChecks.set(client, check);
  return check;
}

/**
 * 纯工具：剥除每个 stdio mcpServers 条目的 pathPrepend 键（http 形态无该字段，原样）。
 * 三个下发点（session create / session resume / mcp/list）共用此单一路径，不复制实现。
 */
export function stripMcpServersPathPrepend(
  servers: ZCodeAgentMcpServer[] | undefined,
): ZCodeAgentMcpServer[] | undefined {
  if (!servers) return servers;
  if (!servers.some((server) => "command" in server && server.pathPrepend !== undefined)) {
    return servers;
  }
  return servers.map((server) => {
    if (!("command" in server) || server.pathPrepend === undefined) {
      return server;
    }
    // 整键剥除（不保留 undefined 值键），与旧 CLI 的 strict schema 未知键语义对齐。
    const { pathPrepend: _stripped, ...rest } = server;
    return rest;
  });
}

/** 三下发点统一门控：flag true 透传原数组；false/unknown/探测失败剥除后下发。 */
export async function gateMcpServersPathPrepend(
  client: Pick<ZCodeProtocolClient, "request">,
  servers: ZCodeAgentMcpServer[] | undefined,
): Promise<ZCodeAgentMcpServer[] | undefined> {
  if (!servers) return servers;
  const supported = await supportsMcpPathPrepend(client);
  return supported ? servers : stripMcpServersPathPrepend(servers);
}
