# 合作方回调上传的流式成组接收

这是 multipart-callback 的 Node.js 项目：本地资料源启动与来源检查，加上 `src/workflow.mjs` 承载的回调接收工作流。接收端 `POST /deliver` 流式解析 multipart/related，按 Content-ID 把清单与文件组成一组，校验字节数与 SHA-256 后一次性发布，并提供 `GET /receipts/:id` 与组内文件读取。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。资料源仅使用本地接口或本地合成设备进程。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t multipart-callback:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
```

`npm test` 检查资料源与接口读取、multipart 解析器的分块与边界用例，以及接收服务的落盘、重送与重启行为。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 `stateDir/result.json`。不能依赖调用方持有的内存来完成恢复。

run 启动自己的本地 POST /deliver 接收入口，再 POST 来源 /send，正文 {target:接收地址}。请求为 multipart/related；x-delivery-id 是交付号，manifest part 的 Content-ID 为 manifest，其他 part 由清单 files 引用。GET /receipts/:id 是收据查询。输出 received/conflicts/incomplete 与真实文件证据，source /send 的断连不表示接收完整。

## 接收端行为

- **顺序无关**：part 按 Content-ID 识别，清单可在前也可在后；文件名、part 顺序都不参与身份判定。重复 Content-ID、清单引用缺件、part 未被引用、字节数或摘要不符都会拒绝整组。
- **有界落盘**：解析器逐块处理字节，不 `split` 整个请求；遇到可能的 `\r\n--boundary` 前缀时只保留窗口内的尾部字节，其余立即写入暂存文件。文件内部的近似边界（`--boundary-x`、`--boundary--x`、只有空白后跟非 CRLF）按原字节保留。
- **先落盘、后可见**：客户端在关闭边界前中断时，暂存目录被删除，`GET /receipts/:id` 返回 404，也不会生成组目录。成功时文件与清单先写入组临时目录并 fsync，整体 rename 成组目录，最后写 `receipt.json`，之后才返回 HTTP 成功。
- **重送与冲突**：重送整组摘要一致时复用原收据（200，`replayed: true`），不再产生第二份资料；同交付号内容变化返回 409 `delivery-conflict`，已接收文件保持原样。
- **重启**：启动时清空 `staged/` 下所有未完成暂存，删除没有 `receipt.json` 的组目录；已接收组及其文件不会被清理。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

acceptance 检查结果、落盘内容和实际来源访问；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none multipart-callback:local npm test`。容器内回环端口可用；正式核对过程不连接外部网络。
