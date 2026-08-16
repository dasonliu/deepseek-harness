# Agent Note: Web 输入框拖入文件的路径插入

Status: implemented

[English](2026-08-16-web-drop-file-path-insertion.md) | 中文

## Problem

Web 输入框过去只通过粘贴与拖放接收图片；引用本地文件需要把完整路径手打进草稿。最直接的恢复通道被平台关闭了：所有引擎都移除了 `File.path`，普通浏览器页面无法从 `File` 对象本身读到绝对路径。

## Decision

拖入的文件在 `InputBar` 的 document 级 drop 监听里按类型分流。图片媒体类型保留原有附件栏通道（分流依据宿主的 `imageLimits.mediaTypes`，无该投影时退化为 `image/*` 前缀）；其余文件则在光标处把绝对本地路径插入草稿，每个路径一行，作为带 DOM 观测编辑区间的单次 `setDraft` 事务（一个撤销步骤，复用粘贴路径的光标恢复／track 流程）。

路径来自拖拽源的 URI-list 格式，由纯模块 `packages/client/ui-conversation/src/client/input/dropped-paths.ts` 恢复：

- `text/uri-list`（Windows/Linux 上 Chromium 会为系统文件拖拽填入 file:// URI），其次 `public.file-url`（WebKit 在 macOS 的等价物），再退化为 `text/plain` 中的裸 Windows 绝对路径。
- `pathFromFileUrl` 把 `file:///C:/…` 解码为 `C:/…`、`file:///…` 解码为 POSIX 路径、`file://server/share/x` 解码为 UNC 拼写 `\\server\share\x`；百分号转义解码，片段剥离，畸形转义拒绝。
- `matchDroppedPaths` 在数量一致时按位置把路径与文件配对（URI 列表按文件顺序发出），否则按大小写不敏感的文件名匹配第一个未用候选。

浏览器只描述文件而未给出路径时，改经新增的 loopback 限定的 host RPC 上传，而非被猜测。`host.uploadDroppedFile` 接收 `{ name, content, cwd }`（规范 base64 字节），写入 `<cwd>/.dsh-uploads/<name>`——`cwd` 必须是宿主启动目录或已注册工作区根，`name` 是校验过的单个 basename，重名时用数字后缀去重而非覆盖。单文件上限 20 MB。写入后的绝对路径即为 composer 插入的内容，参考文件即以副本形式落到项目目录，完全不做磁盘遍历，原始位置也无需知晓——正好契合「只读参考」的用途。客户端经 `WorkspacesService.uploadDroppedFile` 调用（作为输入栏的 `uploadDroppedFile` face 注入，负责读取 File 字节并隐藏 cwd），该方法与其他 host 文件系统方法一样被限定在 loopback。上传进行中 composer 显示不定态「上传中」提示条；上传失败的文件计入一条带文件名的 `file.pathUnavailableNamed` 提示。`canAcceptDrop` 不再依赖图片服务——未组合该服务的装配仍可插入路径。拖放遮罩文案从图片扩展为文件（`drop.*` 键），粘贴手势保持不变：仍只接收图片。插入的路径是普通草稿文本，和任何手打消息一样到达模型。

## Alternatives considered

- **宿主侧文件搜索（按名称＋大小遍历工作区与常用根目录）**——上一版遍历会话工作区、启动目录、全部已注册工作区与账户的桌面／下载／文档／图片，以找回「原始路径」。被否决：参考文件只读不改，找回原始位置毫无收益，却要付出有界但真实的遍历成本，还有同名同大小、根目录之外等歧义失败模式。改为上传副本模型。
- **仅做 URI-list 提取并配以提示兜底**——只依赖拖拽的 URI-list 格式，浏览器不提供时弹提示。保留为**优先快速通道**（浏览器提供时仍瞬时返回原始路径），但无法作为全部答案：Windows Chrome 不提供。
- **`DataTransferItem.getAsFileSystemHandle()` / File System Access API**——Chrome 只授予 handle 而非路径，无法达成目标；其授权模型也没有 drop 形态。
- **只插入文件名**——模型将不得不猜测或搜索路径，恰好重新引入本功能要消除的手打成本。
- **为拖入路径生成 chip**——铸造 `Occurrence` chip 会把无需解析的纯文本拖进引用序列化管线；纯文本插入才是路径的诚实形态。

## Verification

`dropped-paths.spec.ts` 固定解码器（盘符／POSIX／UNC 形态、百分号转义、片段、畸形 URI、格式优先级、去重）与配对规则。`api-proxy-workspace.spec.ts` 经真实 `createApiProxy` 验证 `host.uploadDroppedFile`：字节落到 `.dsh-uploads/<name>`、重名去重、非工作区 `cwd`／超限／非规范 base64 各以独立错误码失败；RPC 经 fetch carrier 往返，`rpc-schemas.spec.ts` 固定请求／响应 schema。`workspaces-service.client.spec.ts` 固定客户端服务的载荷／路径／错误映射。`input-bar.client.spec.tsx` 在真实 `SessionInputShell` 上固定输入栏行为：光标插入、图片／文件分流、媒体类型分流、以及异步上传的各结局（成功、部分失败、上传中提示条）。组装应用通道（`apps/web/tests/image-display.snapshot.ts`）在已构建的客户端图上用合成 `text/uri-list` 载荷拖入一个 PDF，断言路径落入草稿且附件栏不受影响，再拖入一个无路径的文件并断言 `.dsh-uploads` 副本路径落入草稿。

## Consequences

- 提供 URI-list 路径的浏览器（macOS 的 WebKit）瞬时插入原始路径；其余浏览器上传字节并插入 `.dsh-uploads/` 副本路径，因此无论原文件在哪，拖放都快且受限。
- 拖入的参考文件是只读副本：要改原件，需 agent 的 filesystem 工具针对原始位置操作，而这条路径从不找回原始位置。文件夹拖放仍不响应（目录拖拽的 Files 列表为空），不在范围内。
- 上传只写入已知项目根目录、并拒绝带路径分隔符的文件名，因此 loopback 调用方无法借此写任意文件；单文件上限 20 MB。
- URI-list 路径文本不做客户端校验：过期或伪造的条目（例如合成拖拽）会原样插入解码结果，与手打文本无异。宿主沙箱与工具仍然决定该路径是否真的可读。
