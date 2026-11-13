# 来源与接收约定

run 启动自己的本地 POST /deliver 接收入口，再 POST 来源 /send，正文 {target:接收地址}。请求为 multipart/related；x-delivery-id 是交付号，manifest part 的 Content-ID 为 manifest，其他 part 由清单 files 引用。GET /receipts/:id 是自己产品的收据查询。输出 received/conflicts/incomplete 与真实文件证据，source /send 的断连不表示接收完整。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 清单在后正常接收

业务输入：
```json
{
  "transfer": "after-manifest"
}
```
结果必须包含：
```json
{
  "received": [
    "d1"
  ],
  "conflicts": []
}
```

### 同编号不同内容隔离

业务输入：
```json
{
  "transfer": "conflict"
}
```
结果必须包含：
```json
{
  "received": [
    "d1"
  ],
  "conflicts": [
    "d1"
  ]
}
```

### 半截请求没有完成收据

业务输入：
```json
{
  "transfer": "truncated"
}
```
结果必须包含：
```json
{
  "received": [],
  "incomplete": [
    "d1"
  ]
}
```

### 文件包含近似边界仍保真

业务输入：
```json
{
  "transfer": "boundary-like"
}
```
结果必须包含：
```json
{
  "received": [
    "d1"
  ],
  "conflicts": []
}
```
