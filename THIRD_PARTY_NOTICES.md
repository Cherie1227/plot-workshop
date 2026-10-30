# 第三方来源与许可

## Anima 兼容实现

`lib/anima.js` 参照 Ellinav / Ellina 的以下项目实现兼容：

- [Anima-Memory-System](https://github.com/Ellinav/Anima-Memory-System)，核对前端 3.3.6，提交 `d92dfc4dc741386962091ac149a7ed4b4b04e95d`；[上游许可](https://github.com/Ellinav/Anima-Memory-System/blob/main/LICENSE.txt)。
- [anima-rag](https://github.com/Ellinav/anima-rag)，核对提交 `4ee45d16f3a40a65903cde9d75cbdb79d9e6ae48`；[上游许可](https://github.com/Ellinav/anima-rag/blob/main/LICENSE.txt)。

上游采用 **Creative Commons Attribution-NonCommercial 4.0 International（CC BY-NC 4.0，署名—非商业性使用）**。涉及上游作品及其改编的部分遵循该许可，须保留来源与修改说明，限非商业使用。完整条款、免责声明及责任限制见 [CC BY-NC 4.0 法律文本](https://creativecommons.org/licenses/by-nc/4.0/legalcode)。上述许可说明不用于替其他独立文件另行选择许可证，也不授予上游未授予的权利。

修改范围：围绕既有查询、摘要选择与状态读取流程实现适配层，增加本轮上下文绑定、待发送草稿查询、同轮结果复用、动态世界书写入等待和读取校验、取消与并发保护。原项目的 UI、服务端源码和记忆存储没有打包进本仓库；运行时调用用户已有的官方前端接口。

本扩展独立开发，上游作者没有为本扩展背书。上游组件保持各自的来源及许可。

## SillyTavern

通过官方扩展入口、上下文、事件和临时提示词接口集成。没有在仓库内打包酒馆宿主源码。

- [官方扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern 官方仓库](https://github.com/SillyTavern/SillyTavern)

## 内置预设

内置 `presets/default.json` 是为本扩展编写的模块化规划预设。本仓库不包含用户导入的原始私有预设、聊天记录、角色卡、世界书、API 密钥或任务归档。
