---
name: feedback-fixes
description: 本项目开发中的关键错误和修复模式（持续更新）
type: feedback
originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 2026-05-14 本会话新增

### max_tokens 4096 不够 → 复杂 JSON 输出被截断
**问题**：Phase 10 剪辑指导输出极复杂的 JSON（镜头分段 + 画面建议 + 剪辑建议 + 音乐建议 + 参考方向），4096 token 不够用，JSON 截断 → `parseAIJson` 失败 → 报错信息里 `raw.substring(0, 200)` 让用户误以为是输入有 200 字限制。

**Why**：默认 max_tokens 4096 对简单任务够，对大 JSON 不够。错误信息展示前 200 字符是误导性的——截断发生在末尾，不是开头。

**How to apply**：
1. 后端 `max_tokens` 默认值提至 16384（schemas.py）
2. `parseAIJson` 报错展示末尾 300 字符（截断发生在末尾），并提示可能超长被截断
3. 任何生成大型结构化 JSON 的 Phase，max_tokens 至少 8192

### Sidebar item label fallback 链 → 重复显示
**问题**：Phase 5 `{f.type || f.name}` 和 `{f.title || f.name}` — Prompt 只定义 `name` 字段没定义 `type`/`title`，两个 fallback 都落到 `f.name`，显示 "故事逆袭型 故事逆袭型"。

**Why**：前后端契约不一致——Prompt JSON schema 和渲染代码的字段名不匹配。Tag 不应该 fallback 到 name。

**How to apply**：
1. Tag 只显示有明确类型分类意义的字段（如 type），没有就跳过渲染
2. 标题/名称用 `name || title`（一个 fallback 即可，不要两条链指向同一个值）
3. Prompt 的 JSON key 和渲染代码的字段引用必须对应

### Ant Design Menu 可折叠分组
**问题**：Sidebar 分组越来越多，`type: 'group'` 不支持折叠。

**How to apply**：用 SubMenu（`children`）+ `openKeys`/`onOpenChange` 实现可控可折叠分组，`useState(initialOpenKeys)` 初始化全展开。

---

## 2026-05-11（Skill 系统设计）

### 硬编码方法论 → 可插拔 Skill 系统
**问题**：每个编导的方法论不同（竞品分析方式、脚本风格、钩子偏好），但当前所有方法论都硬编码在 Prompt 字符串中。换一个编导风格就要改代码。

**Why**：开发阶段只关注"让系统跑起来"，方法论是作为示例填充的，没有考虑可替换性。

**How to apply**：
1. 方法论从 Prompt 中剥离，Prompt 骨架只定义输出格式和分析流程
2. Prompt 中放 `{{SKILL:name}}` 插槽标记，运行时从 Skill 系统注入实际内容
3. 分层继承：基座层（系统默认）+ 用户层（个人覆盖），逐维合并
4. Skill 系统做成独立模块，对外只暴露一个接口，内部变更不影响 Phase 组件

### 防止项目架构腐烂
**问题**：项目预计迭代很多轮，担心屎山代码导致后期升级困难。已踩过的坑：navigate 到未注册路由白屏、自动清理数据、硬编码模型配置、Prompt 混在组件文件里。

**Why**：快速开发阶段容易积累技术债——文件膨胀、跨 Phase 耦合、类型系统被绕过。

**How to apply**（已写入 CLAUDE.md）：
1. Phase 自封闭：Phase 之间不直接 import，共享逻辑走 services/stores
2. 新增功能 = 新增文件：文件 > 200 行评估拆分
3. Prompt 与组件分离：每个 Phase 的 Prompt 独立 `prompts.ts`
4. 破坏性操作需显式触发：不搞自动删除/清理/迁移
5. 新增路由 = 必注册占位：实现 Phase N 时注册 N+1 占位路由
6. 前后端契约显式定义：Schema 变更 → TypeScript 类型同步
7. commit 前 TS 0 错误 + Python 导入通过

### DeepSeek API 401 诊断
**问题**：分析请求失败，错误 401 Authorization Required，URL 指向 `api.deepseek.com`。

**Why**：API key 过期或无效。后端路由链路正常（前端 → store → infer() → backend → openai_chat() → DeepSeek），问题在密钥本身。

**How to apply**：401 先检查密钥有效性，不是代码问题。在设置页 `/settings` 的 `通用推理` 槽位更新 API key。

---

## 2026-05-11 Prompt 质量诊断

**问题**：用户反馈分析质量差（信息收集弱、竞品分析差、脚本老旧），怀疑是模型配置问题。实际诊断：模型配置链路通（前端→后端正确路由），根因是所有 System Prompt 都是"JSON 格式模板"而非"专家指导"——告诉模型输出什么格式，没告诉怎么像编导一样思考。

**Why**：开发阶段关注"跑通"，Prompt 只是定义了输出 Schema，没有注入编导领域知识（分析框架、方法论、平台特性、趋势信息）。

**How to apply**：
1. 诊断 AI 质量问题时，先检查 Prompt 质量 → 再检查模型配置 → 最后才怀疑模型能力
2. Prompt 必须包含：具体分析框架（不是泛泛的"分析X"）、正反面示例（什么是对什么是错）、领域约束（如"不要说'年轻人'，要说'考研党'"）、当前趋势信息
3. 用户说"先用搜索填充，等我空了再输入方法论"——先做 research 再定制化，两阶段推进

---

## 2026-05-08 本会话新增

### navigate 到未注册路由导致应用崩溃 + 数据丢失
**问题**：Phase 2 审批通过 → `navigate('/phase/3')` → App.tsx 未注册该路由 → React Router 找不到匹配 → 整个应用白屏崩溃 → Zustand 内存状态丢失 → 重载后数据可能损坏。

**Why**：只实现了 Phase 0-2 的路由，Phase 3+ 未注册。`completeAndLock` 解锁了 Phase 3 状态，前端代码有 "继续" 按钮但目标页面不存在。

**How to apply**：
1. 实现 Phase N 时，**必须同时注册 Phase N+1 的占位页和路由**，即使它只是一个"即将推出"的骨架
2. `navigate()` 调用的目标路由必须存在于 `<Routes>` 中
3. Phase 占位页模板：含 `phaseStatus['N'] === 'locked'` 守卫 + "返回上一阶段" 按钮

### 自动清理代码是定时炸弹
**问题**：AppShell.tsx 中有一段 "一次性 localStorage 清理"——检查 `__cleaned_20260507__` 标记，没有则删除 db_projects/db_phase_results。重启 dev server 后标记丢失，清理再次执行，用户所有项目数据被清空。

**Why**：自动破坏性操作（删除/清空/重置）没有用户确认，依赖 localStorage 中的标记持久性（不可靠）。且清理逻辑在组件 mount 时执行，HMR/Vite 重启都可能触发。

**How to apply**：
1. **永远不要**在代码中写自动清除用户数据的逻辑
2. 如果需要数据迁移或清理，做成用户可见的按钮或设置项
3. localStorage 标记不是可靠的"只执行一次"机制
4. 破坏性操作必须用户主动触发，不能让 useEffect/组件 mount 自动执行

---

## 2026-05-07 本会话新增

### React Hooks 写在 JSX 三元表达式内
**问题**：Phase1/index.tsx 中 `usePhaseStore()` 写在 JSX 三元表达式里 → step='report' 时 hook 不执行 → hooks 数量变化 → React 抛 "Rendered fewer hooks than expected"。

**Why**：`{step === 'input' ? <Comp hook={usePhaseStore(...)} /> : <OtherComp />}` — hook 只在 true 分支执行，false 分支跳过。React 要求每个组件每次渲染调用完全相同数量的 hooks。

**How to apply**：所有 hook 调用必须写在组件函数体顶层（return 之前），不能出现在 if/ternary/loop 内部。Zustand 的 `useStore(selector)` 也是 hook。

### Zustand store 在 Vite HMR 下的状态丢失
**问题**：修改 store 文件后 HMR 热替换模块，React 组件可能持有旧闭包的 store 引用。症状是"代码改了但行为没变"。

**Why**：Vite HMR 替换 ES module 时，已挂载的 React 组件中的 hook 订阅可能指向旧模块的 store 实例。

**How to apply**：调试 Zustand store 改动时，先硬刷新浏览器（Ctrl+Shift+R）。如果 HMR 行为异常，重启 Vite dev server。

### electron/main.ts 修改后必须重编译
**问题**：`dist-electron/` 被 .gitignore 排除，修改 `electron/main.ts` 后运行 `npm run dev` 不会自动重编译。

**Why**：`npm run dev` 只启动 Vite，不编译 Electron 主进程。Electron 启动时加载的是 `dist-electron/electron/main.js`。

**How to apply**：修改 electron/ 下的任何文件后，运行 `npx tsc -p tsconfig.node.json` 更新编译产物。

## 2026-05-07 前序会话

### Vite 不响应 127.0.0.1（前端拒绝访问）
**问题**：Vite dev server 默认只绑定 `localhost`，Windows 上用 `http://127.0.0.1:5173/` 访问提示拒绝连接。

**Why**：`localhost` 和 `127.0.0.1` 在 Windows 上是不同网络接口。Vite 不加 `--host` 时只监听 IPv6 localhost。

**How to apply**：`npx vite --host 0.0.0.0` 绑定所有接口。这是 Windows 开发的标准操作。

### Claude Code 权限弹窗过多
**问题**：`settings.json` 中 `permissions.allow` 条目都是参数完全精确的字符串匹配（如具体 JSON payload），每次参数变化就需要重新审批。

**Why**：之前在 allowlist 中保存了完整的 curl 命令（包括 JSON body），因为转义复杂导致条目越来越多。

**How to apply**：
1. 用通配符模式替代精确匹配：`Bash(curl -s *)` 而不是 `Bash(curl -s -X POST ... -d "{...}")`
2. `:*` 是旧版前缀匹配语法，必须出现在模式末尾，`http://:*` 是无效的
3. 常见开发操作（curl、taskkill、netstat、启动后端）用宽泛模式覆盖

### 后端硬编码模型选择（前端配置无效）
**问题**：用户在设置页配置了 API，但系统仍然使用本地 Ollama。后端 `inference.py` 写死了 `SLOT_DEFAULTS`，前端配置从未传给后端。

**Why**：前端 modelStore 存了配置，但 `infer()` 只传 `{slot, prompt, system_prompt}`，provider/model/apiKey 都没传。

**How to apply**：
1. 前端 `infer()` 必须从 store 读取当前 slot 的完整配置并传给后端
2. 后端 Schema 必须包含 provider/model/api_base/api_key 字段
3. 后端按 provider 字段路由到不同服务

### 图表类型选择错误
**问题**：痛点热力图用 ECharts heatmap，但数据是"每个痛点属于一个分类"（1对1），不是多对多矩阵。结果稀疏、长文本标签不可读。

**Why**：heatmap 适合稠密矩阵，不适合 5-8 个独立数据点。

**How to apply**：独立排名用横向柱状图，多对多关系才用热力图。数据量 < 20 不考虑 heatmap。

### 任务过重导致 7b 模型失败
**问题**：SYS_MATCH 要求同时输出 matchMatrix + reasoningSteps，qwen2.5:7b 经常超时或 JSON 不完整。

**Why**：单次请求要求生成太多分析内容，CPU 推理跑不完。

**How to apply**：每个子任务只要求一个数组输出。matchMatrix 和 reasoningSteps 拆成两个独立并行任务。

### Prompt 领域知识缺失
**问题**：受众画像分析跑偏，生成泛泛的"年轻人""白领"而非短视频平台真实用户画像。

**Why**：System Prompt 缺少短视频领域知识引导。

**How to apply**：
1. System Prompt 必须包含领域约束（如"用短视频平台标签体系"）
2. 给出反面例子（不要"年轻人"，要"精致妈妈"）
3. 要求行为层面描述（什么时间刷、偏好什么内容形式）

### 设置向导 auto-advance 跳过用户选择
**问题**：EnvDetect 检测完成后 800ms 自动跳到下一步，用户来不及看结果。InstallProgress 的 useEffect 依赖内联函数导致定时器反复重启。

**Why**：auto-advance 是为了"流畅体验"，但实际上是跳过用户选择权。useEffect 依赖内联函数在每次 render 时重建定时器。

**How to apply**：
1. 不做 auto-advance，等用户手动点「下一步」
2. useEffect 中引用的回调用 `useRef` 存储，依赖数组保持 `[]`

---

## 之前积累的修复模式

## 2026-05-13 白屏根因 #2：Zustand selector 返回新引用 → 无限重渲染

**问题**：`ReminderBadge.tsx` 中 `useTrackingStore((s) => s.getPendingReminders())` — `getPendingReminders()` 每次调用返回新数组引用。Zustand 用 `Object.is` 比较 selector 返回值，每次都是新引用 → 触发重渲染 → 再次调用 selector → 又返回新引用 → 无限循环 → "Maximum update depth exceeded" → 白屏。

**Why**：Zustand selector 返回的引用必须稳定。`.filter()`、`.map()`、`.reduce()` 以及任何工厂函数每次返回新对象/数组，都会触发这个循环。

**How to apply**：
1. Selector 只选原始值或稳定引用（字符串、数字、store 上的函数引用）
2. 需要派生数据时：选原始数据 + `useMemo` 在组件内计算
3. 模式：`const fn = useStore(s => s.getXxx); const data = useStore(s => s.rawData); const result = useMemo(() => fn(), [data, fn]);`

## 2026-05-13 白屏根因 #1：antd `App.useApp()` 缺少 `<App>` 祖先

**问题**：`ImportPanel` 等组件使用 `App.useApp()` 获取 message 实例，但 `main.tsx` 只有 `<ConfigProvider>` 没有 `<App>` 组件。缺少祖先导致 hooks 返回 undefined，React 渲染崩溃白屏。

**Why**：antd 5.x 的 `message.notification.modal` 静态方法需要 `<App>` 组件提供上下文。`ConfigProvider` 只管主题，不管 App 上下文。

**How to apply**：`main.tsx` 必须 `<ConfigProvider><AntdApp><HashRouter><App /></HashRouter></AntdApp></ConfigProvider>`。所有使用 `App.useApp()` 的组件都需要这个祖先链。

## 2026-05-13 Vite 僵尸进程：IPv4/IPv6 双监听

**问题**：端口 5173 上同时有新旧两个 Vite 进程，一个监听 IPv6 `[::1]`，一个监听 IPv4 `0.0.0.0`。Windows 解析 `localhost` 优先 IPv6，浏览器连到僵尸旧进程，刷新多少次都是旧代码。

**Why**：`taskkill /F /PID` 在 Windows 上不一定能杀掉进程（有时需要 PowerShell `Stop-Process`）。旧进程持有端口 IPv6 监听，新进程创建 IPv4 监听，两者并存。

**How to apply**：杀掉 Vite 后用 `netstat -ano | grep 5173` 确认端口完全清空再重启。用 `powershell -Command "Stop-Process -Id <pid> -Force"` 比 `taskkill` 更可靠。

### Phase 渲染崩溃模式
AI 返回 JSON 字段名和 TypeScript 类型不匹配，导致 `undefined.map()` 崩溃。

**How to apply**：
1. 所有 Phase 的 System Prompt 中 JSON 字段名必须严格匹配 TypeScript 类型定义
2. 所有从 AI 返回数据中取数组的地方必须加 `|| []`
3. 报告组件用 `safe = { field: data.field || [], ... }` 模式统一兜底
4. 顶层用 ErrorBoundary 包裹防止白屏

### Timeout 模式
qwen2.5:7b CPU 推理，大型 JSON 生成可能超时。

**How to apply**：大分析任务拆成 4-5 个并行小请求，用 `Promise.allSettled` 合并，部分失败不阻塞整体。

### 路径问题
ESM `__dirname` 在编译前后位置不同。

**How to apply**：用 `app.getAppPath()` 代替 `__dirname` 计算项目根目录路径。
