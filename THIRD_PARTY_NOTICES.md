# 第三方来源与许可

## Anima 兼容实现

`lib/anima.js` 参照 Ellinav / Ellina 的以下项目实现兼容：

- [Anima-Memory-System](https://github.com/Ellinav/Anima-Memory-System)，核对前端 3.3.6，提交 `d92dfc4dc741386962091ac149a7ed4b4b04e95d`；[上游许可](https://github.com/Ellinav/Anima-Memory-System/blob/main/LICENSE.txt)。
- [anima-rag](https://github.com/Ellinav/anima-rag)，核对提交 `4ee45d16f3a40a65903cde9d75cbdb79d9e6ae48`；[上游许可](https://github.com/Ellinav/anima-rag/blob/main/LICENSE.txt)。

上游采用 **Creative Commons Attribution-NonCommercial 4.0 International（CC BY-NC 4.0，署名—非商业性使用）**。涉及上游作品及其改编的部分遵循该许可，须保留来源与修改说明，限非商业使用。完整条款、免责声明及责任限制见 [CC BY-NC 4.0 法律文本](https://creativecommons.org/licenses/by-nc/4.0/legalcode)。上述许可说明不用于替其他独立文件另行选择许可证，也不授予上游未授予的权利。

修改范围：围绕既有查询、摘要选择与状态读取流程实现适配层，增加本轮上下文绑定、待发送草稿查询、同轮结果复用、动态世界书写入等待和读取校验、取消与并发保护，以及不执行召回的安装/依赖检测。原项目的 UI、服务端源码和记忆存储没有打包进本仓库；运行时调用用户已有的官方前端接口，不改动其重要记忆、Echo 保留或长期记忆规则。

本扩展独立开发，上游作者没有为本扩展背书。上游组件保持各自的来源及许可。

## SillyTavern

通过官方扩展入口、上下文、事件和临时提示词接口集成。没有在仓库内打包酒馆宿主源码。

固定大纲正文重写使用宿主的 `context.swipe.to` 接口保存消息候选；快捷命令通过 `SlashCommandParser` / `SlashCommand.fromProps` 注册。相关接口依运行时能力检查提供，未在扩展中替换酒馆生成实现。

- [官方扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern 官方仓库](https://github.com/SillyTavern/SillyTavern)

## 内置预设

内置 `presets/default.json` 是为本扩展编写的模块化规划预设。本仓库不包含用户导入的原始私有预设、聊天记录、角色卡、世界书、API 密钥或任务归档。

0.2.7 根据用户提供的《Ashen Bridge · 灰烬之桥》中“结尾落点”“收尾之思”“人性之思”，及其提供的“Claude自由意志”“增加阴暗·欲望与行动”等条目的创作思路，重新组织为本轮规划的结尾、人性灰度和欲望行动模块。保留具体创作偏好，交付到本扩展现有事件字段；未打包来源预设全文、原脚本、正则或其强制优先级声明。

## Amor 产品思路参考

Vespera 0.2.0 在产品讨论中只读参考了 [Amor 仓库](https://gitee.com/jiangzaizai/Amor)，核验版本为 1.16.0，提交 [`728fa7b8ff5072d71c85b996fbd6a25059c6087e`](https://gitee.com/jiangzaizai/Amor/tree/728fa7b8ff5072d71c85b996fbd6a25059c6087e)，日期 2026-10-24。参考范围为注入预览、规划版本查看、用户主动诊断及备份等产品思路。

在该核验提交中未找到 LICENSE 文件或明确许可声明。Vespera 没有复制 Amor 的代码、提示词或资源，相关模块依据本项目自己的上下文校验、Anima 调度和交接协议独立实现。此次产品参考不意味着取得 Amor 源码的复制或再分发许可，也不表示上游作者背书。本仓库不包含其下载源码。

## 界面美术

`assets/celestial-header.png` 为本项目使用 OpenAI 图像生成工具创建的星轨天文钟装饰，不取自 Amor、Anima 或用户提供的参考截图。参考截图只用于理解风格偏好，没有作为界面背景复制或打包。界面文字、图标与底纹由本项目代码渲染。
