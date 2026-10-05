import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { IDisposable } from "@zcode/rpc";
import type { IRemoteBackend } from "@zcode/server/remote";
import type { ZCodePromptAttachment } from "@zcode/shared";
// 3.14.5 Alpha 0（specs/bot-file-delivery.md「Inbound remote workspaces」A1）：
// desktop-host 远程 prompt 附件包装器的特征化测试——A1 让 file/pdf/video 也携带
// localPath 后，该包装器（无需代码改动）即可把它们上传到远端并改写附件与 prompt
// 行中的路径。这里用 fake backend 钉住：passthrough、上传+双重路径改写（含
// Windows 分隔符路径与多附件顺序稳定）、上传失败抛错、已在远端根下不重传、
// dataBase64-only 附件原样透传。
import { materializeRemotePromptAttachments } from "../src/host/remotePromptAttachments.js";

interface FakeBackendControl {
  /** 每次 upload 调用记录（localPath → remotePath）。 */
  uploads: Array<{ localPath: string; remotePath: string }>;
  /** exec 执行过的命令序列（HOME 解析 / mkdir / chmod / rm）。 */
  commands: string[];
  /** 让 upload 抛错（传输失败路径）。 */
  failUploadWithError?: Error;
}

/** fake backend：exec 模拟 `printf %s "$HOME"` → /home/u，其余命令（mkdir/chmod/rm）exit 0。 */
function createFakeBackend(homeDir = "/home/u"): {
  backend: Pick<IRemoteBackend, "exec" | "upload">;
  control: FakeBackendControl;
} {
  const control: FakeBackendControl = { uploads: [], commands: [] };
  const backend: Pick<IRemoteBackend, "exec" | "upload"> = {
    async exec(command: string) {
      control.commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners = new Set<(code: number) => void>();
      // 与真实通道一致异步送达：等调用方挂好 data/onClose 监听后再发射。
      setImmediate(() => {
        if (command === 'printf %s "$HOME"') {
          stdout.write(homeDir);
        }
        stdout.end();
        stderr.end();
        for (const listener of listeners) {
          listener(0);
        }
      });
      return {
        stdout,
        stderr,
        onClose(listener: (code: number) => void): IDisposable {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
    },
    async upload(localPath: string, remotePath: string) {
      if (control.failUploadWithError) {
        throw control.failUploadWithError;
      }
      control.uploads.push({ localPath, remotePath });
    },
  };
  return { backend, control };
}

const REMOTE_ROOT = "/home/u/.zcode/tmp/prompt-attachments";

test("无附件：原样 passthrough，uploadedCount 0，零 exec/upload", async () => {
  const fake = createFakeBackend();
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-1", content: "普通消息", traceId: "trace-1" },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 0);
  assert.equal(result.content, "普通消息");
  assert.equal(result.attachments, undefined);
  assert.equal(fake.control.uploads.length, 0);
  assert.equal(fake.control.commands.length, 0, "无附件时不得触碰远端");
});

test("单个 file 附件：上传到远端私有根，附件路径与 prompt 行路径同步改写", async () => {
  const fake = createFakeBackend();
  const localPath = "/tmp/desktop-cache/zcode/bot-attachments/b/m/report.pdf";
  const attachments: ZCodePromptAttachment[] = [
    {
      kind: "file",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      localPath,
    },
  ];
  const content = `请阅读附件\n\n附件：report.pdf (application/pdf, 1.2KB)，已保存到：${localPath}`;
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-2", content, traceId: "trace-abc", attachments },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 1);
  assert.equal(fake.control.uploads.length, 1);
  assert.equal(fake.control.uploads[0].localPath, localPath);
  assert.match(
    fake.control.uploads[0].remotePath,
    /^\/home\/u\/\.zcode\/tmp\/prompt-attachments\//u,
  );
  // 文件名保留在远端路径尾部（trace/nonce/序号前缀 + 消毒后的文件名）。
  assert.ok(
    fake.control.uploads[0].remotePath.endsWith("report.pdf"),
    fake.control.uploads[0].remotePath,
  );
  // 附件 localPath 改写为远端路径，其余字段保真。
  assert.equal(result.attachments?.length, 1);
  assert.equal(result.attachments?.[0].localPath, fake.control.uploads[0].remotePath);
  assert.equal(result.attachments?.[0].kind, "file");
  assert.equal(result.attachments?.[0].sizeBytes, 1234);
  assert.equal(result.attachments?.[0].filename, "report.pdf");
  // prompt 文本中的本地路径子串被替换为远端路径。
  assert.ok(result.content.includes(fake.control.uploads[0].remotePath));
  assert.ok(!result.content.includes(localPath));
  // 私有目录收紧（mkdir + chmod 700）与文件 chmod 600 都执行过。
  assert.ok(fake.control.commands.some((command) => command.includes("mkdir -p")));
  assert.ok(fake.control.commands.some((command) => command.includes("chmod 700")));
  assert.ok(fake.control.commands.some((command) => command.includes("chmod 600")));
});

test("多附件含 Windows 风格 localPath：两者都改写，顺序稳定", async () => {
  const fake = createFakeBackend();
  const windowsPath = "C:\\Users\\me\\.zcode\\v2\\bot-attachments\\b\\m\\f.pdf";
  const posixPath = "/tmp/desktop-cache/notes.txt";
  const attachments: ZCodePromptAttachment[] = [
    {
      kind: "pdf",
      filename: "f.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      localPath: windowsPath,
    },
    {
      kind: "file",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 20,
      localPath: posixPath,
    },
  ];
  const content = `两个附件：${windowsPath} 和 ${posixPath}`;
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-3", content, traceId: "trace-multi", attachments },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 2);
  assert.equal(fake.control.uploads.length, 2);
  // 顺序稳定：第 1 个上传对应第 1 个附件（Windows 路径），第 2 个对应 posix 路径。
  assert.equal(fake.control.uploads[0].localPath, windowsPath);
  assert.equal(fake.control.uploads[1].localPath, posixPath);
  assert.match(
    fake.control.uploads[0].remotePath,
    /^\/home\/u\/\.zcode\/tmp\/prompt-attachments\//u,
  );
  assert.match(
    fake.control.uploads[1].remotePath,
    /^\/home\/u\/\.zcode\/tmp\/prompt-attachments\//u,
  );
  assert.equal(result.attachments?.[0].localPath, fake.control.uploads[0].remotePath);
  assert.equal(result.attachments?.[1].localPath, fake.control.uploads[1].remotePath);
  assert.notEqual(fake.control.uploads[0].remotePath, fake.control.uploads[1].remotePath);
  // 内容中的两个本地路径（含反斜杠形式）都被精确子串替换。
  assert.ok(!result.content.includes(windowsPath));
  assert.ok(!result.content.includes(posixPath));
  assert.ok(result.content.includes(fake.control.uploads[0].remotePath));
  assert.ok(result.content.includes(fake.control.uploads[1].remotePath));
});

test("backend.upload 抛错：materialize 抛出携带文件名的错误（远端暂存已回收）", async () => {
  const fake = createFakeBackend();
  fake.control.failUploadWithError = new Error("sftp write broken");
  await assert.rejects(
    materializeRemotePromptAttachments(
      {
        taskId: "task-4",
        content: "附件：shot.png 已保存到：/tmp/desktop-cache/shot.png",
        traceId: "trace-fail",
        attachments: [
          {
            kind: "image",
            filename: "shot.png",
            mimeType: "image/png",
            localPath: "/tmp/desktop-cache/shot.png",
          },
        ],
      },
      { backend: fake.backend },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /远端附件上传失败/u);
      assert.ok(error.message.includes("shot.png"), "错误信息必须包含文件名");
      return true;
    },
  );
  // 失败边界内尽力回收远端暂存（rm -f 已尝试；fake exec exit 0）。
  assert.ok(fake.control.commands.some((command) => command.includes("rm -f")));
});

test("已在远端附件根下的路径：原样保留，不上传", async () => {
  const fake = createFakeBackend();
  const alreadyRemote = `${REMOTE_ROOT}/trace-old/nonce-old/01-a.pdf`;
  const tildeForm = "~/.zcode/tmp/prompt-attachments/trace-old/nonce-old/02-b.txt";
  const attachments: ZCodePromptAttachment[] = [
    {
      kind: "pdf",
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
      localPath: alreadyRemote,
    },
    {
      kind: "file",
      filename: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      localPath: tildeForm,
    },
  ];
  const content = `已物化：${alreadyRemote} 与 ${tildeForm}`;
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-5", content, traceId: "trace-idempotent", attachments },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 0);
  assert.equal(fake.control.uploads.length, 0);
  // attachments 引用保持原对象（未改写、未重建）。
  assert.equal(result.attachments, attachments);
  assert.equal(result.content, content);
  // 无上传 → 不得执行 mkdir/chmod。
  assert.ok(!fake.control.commands.some((command) => command.includes("mkdir")));
  assert.ok(!fake.control.commands.some((command) => command.includes("chmod")));
});

test("dataBase64-only 附件（无 localPath）：原样透传，不上传", async () => {
  const fake = createFakeBackend();
  const attachments: ZCodePromptAttachment[] = [
    {
      kind: "image",
      filename: "inline.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("abc").toString("base64"),
    },
  ];
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-6", content: "inline image", traceId: "trace-inline", attachments },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 0);
  assert.equal(fake.control.uploads.length, 0);
  assert.deepEqual(result.attachments, attachments);
  assert.equal(result.attachments?.[0].dataBase64, attachments[0].dataBase64);
  assert.equal(result.attachments?.[0].localPath, undefined);
});

// ---- Alpha 7（specs/bot-file-delivery.md「Outbound attachment naming & inline kinds」§5.6）：
// staging 段消毒保留 Unicode 基名——红测先行。依据：handoff §2h 发现②（owner rig
// 2026-10-04 实测：`程曦简历.pdf` 远端落 `01-.pdf`——sanitizePathSegment 的
// `[^A-Za-z0-9._-]+`→`-` 把 CJK 基名整体清光）+ ../ZCode-alpha6-plan.md 附录 C §5.6。

test("A7 §5.6 CJK 基名保留：staging `程曦简历.pdf` 不得塌缩成 `.pdf`", async () => {
  const fake = createFakeBackend();
  const localPath = "/tmp/desktop-cache/zcode/bot-attachments/b/m/程曦简历.pdf";
  const attachments: ZCodePromptAttachment[] = [
    {
      kind: "pdf",
      filename: "程曦简历.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      localPath,
    },
  ];
  const content = `请阅读简历\n\n附件：程曦简历.pdf (application/pdf, 2.0KB)，已保存到：${localPath}`;
  const result = await materializeRemotePromptAttachments(
    { taskId: "task-a7-cjk", content, traceId: "trace-a7-cjk", attachments },
    { backend: fake.backend },
  );
  assert.equal(result.uploadedCount, 1);
  assert.equal(fake.control.uploads.length, 1);
  // 红点：今天远端路径是 `.../01-.pdf`（CJK 基名被清光）；新契约要求 CJK 基名
  // 在远端 staging 路径尾部原样保留（字节预算截断只作用于超预算的超长名）。
  assert.ok(
    fake.control.uploads[0].remotePath.endsWith("程曦简历.pdf"),
    `远端 staging 路径必须保留 CJK 基名（今天塌缩为 01-.pdf）：${fake.control.uploads[0].remotePath}`,
  );
  // 附件与 prompt 行的路径改写照常（改写后的远端路径同样含 CJK 基名）。
  assert.equal(result.attachments?.[0].localPath, fake.control.uploads[0].remotePath);
  assert.ok(result.content.includes(fake.control.uploads[0].remotePath));
  assert.ok(!result.content.includes(localPath));
});
