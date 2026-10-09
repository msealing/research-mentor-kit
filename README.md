# research-mentor-kit

开箱即用的科研智能体套件，基于 [opencode](https://opencode.ai) 打造，**兼容 opencode 2.x（V2 插件 API）**。

包含一个完整的"私人科研导师" Agent（`research-mentor`），可调度 **25 个科研技能包**、**2 个文献检索 MCP 服务**（Paper Search MCP + CNKI 知网检索）和一个 **Ollama 视觉插件**（识图 / OCR / 表格 / 图表解读），覆盖科研全流程：选题 → 文献调研 → 方案设计 → 数据/实验 → 论文写作 → 修改润色 → 答辩准备。

> **V2 迁移说明**：本仓库原 `plugins/vision.ts` 为 V1 插件 API（`export const Vision: Plugin` + `chat.params` 钩子），在 opencode 2.x 上无法加载。现已迁移为 V2 形态（`export default { id, setup }` + `ctx.tool.transform`），服务端配置同步更新为 `plugins` 数组与 `mcp.servers` 分组。

## 目录结构

```
research-mentor-kit/
├── agent/
│   └── research-mentor.md      # 私人科研导师 Agent 定义（科研任务总入口）
├── skills/                     # 25 个科研技能包
│   ├── academic-research-suite/    # 学术研究工作流（深度研究/系统综述/论文流水线）
│   ├── deep-research/              # 深度研究智能体团队
│   ├── academic-paper/             # 12 智能体论文写作流水线
│   ├── academic-paper-reviewer/    # 多视角论文评审
│   ├── academic-pipeline/          # 研究→写作→评审→修订端到端流水线
│   ├── nature-writing/             # Nature 风格论文写作
│   ├── nature-polishing/           # 出版级英文润色
│   ├── nature-reader/              # 论文翻译与精读
│   ├── nature-paper-card/          # 单篇论文深度阅读卡
│   ├── nature-paper2ppt/           # 论文转演讲 PPT
│   ├── nature-reviewer/            # 投稿前模拟同行评审
│   ├── nature-response/            # 审稿意见修回信
│   ├── nature-figure/              # 科研配图（matplotlib/R 双后端）
│   ├── nature-statistics/          # 统计报告审查与撰写
│   ├── nature-citation/            # 严格 Nature/CNS 引用
│   ├── citation-workflow/          # 论文引注与参考文献列表
│   ├── nature-ref-verifier/        # 参考文献多源交叉验证
│   ├── nature-literature-pipeline/ # 自动化文献发现流水线
│   ├── nature-academic-search/     # 多源文献检索与引文管理
│   ├── nature-downloader/          # 合法学术全文下载
│   ├── nature-data/                # 数据可用性声明
│   ├── nature-experiment-log/      # 实验日志记录
│   ├── researchwrite/              # 科研基金本子/开题报告写作
│   ├── journal-rank/               # 期刊分区查询
│   ├── paper-to-obsidian/          # 文献入库 Obsidian
│   └── ...                         # 以及 context7/ppt/docx/pdf/gpt-image 等通用技能
├── plugins/
│   └── vision.ts                # Ollama 视觉插件（V2 API：识图/OCR/表格/图表/PDF 解读）
└── mcp/
    └── cnki-mcp/                # 中国知网检索 MCP 服务（Python 源码）
```

## 环境依赖

| 组件 | 说明 | 获取方式 |
|------|------|----------|
| opencode | 智能体运行时（≥ 2.0） | `npm i -g opencode-ai` |
| uv + Python ≥3.10 | Paper Search MCP 与 cnki-mcp 运行环境 | https://docs.astral.sh/uv/ |
| Ollama | vision.ts 插件的本地视觉模型 | https://ollama.com/ ，模型如 `qwen3.5:4b` |
| MiKTeX (Windows) / TeX Live | 论文 LaTeX 编译（xelatex） | 可选 |
| Obsidian | 文献库/项目笔记库（`{{OBSIDIAN_VAULT}}`） | 可选 |
| Node.js ≥20 | vision.ts 插件运行 | 可选（opencode 自带） |

> 提示：除 opencode + uv + Python 为硬依赖外，其余均按需配置。没有 Ollama 时 vision 插件会自动禁用；没有 Obsidian 时不使用文献入库技能即可。

## 安装步骤

```bash
# 1. 克隆本仓库
git clone https://github.com/msealing/research-mentor-kit.git
cd research-mentor-kit

# 2. 安装配置
#    将 agent、skills、plugins 复制到你的 opencode 配置目录（Windows: %USERPROFILE%\.config\opencode\）
#    或参考 opencode.example.jsonc 在 opencode.jsonc 中声明
#    V2 插件配置形态（对象形式，可带 options）：
#    "plugins": [
#      { "package": "./plugins/vision.ts" }
#    ]

# 3. 配置 Paper Search MCP 密钥
cp env.example .env   # 填入你的密钥（至少 PAPER_SEARCH_MCP_UNPAYWALL_EMAIL）

# 4. 安装 cnki-mcp 依赖
cd mcp/cnki-mcp
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

然后在 opencode 中使用：

```
/model opencode/big-pickle        # 选择一个较强的模型
/research-mentor                  # 或使用 /agent research-mentor 激活科研导师
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `{{OBSIDIAN_VAULT}}` | 你的 Obsidian 库根目录 | 文献库/项目笔记位置 |
| `{{OBSIDIAN_LIBRARY_DIR}}` | `{{OBSIDIAN_VAULT}}/科研/文献库/` | 文献库目录 |
| `{{RESEARCH_DIR}}` | 研究项目目录 | 科研项目的根目录 |
| `{{RESEARCH_OUTPUT_DIR}}` | 研究输出目录 | 论文/图表输出位置 |
| `{{JOURNAL_DATA_DIR}}` | `JOURNAL_RANK_DATA_DIR` 或本地 CSV | 期刊分区数据目录 |
| `{{MIKTEX_XELATEX_BIN}}` | `xelatex`（macOS/Linux 直接用 PATH 中的 xelatex） | MiKTeX xelatex 可执行文件路径（Windows 示例：`C:\Users\<用户名>\AppData\Local\Programs\MiKTeX\miktex\bin\x64\xelatex.exe`） |
| `{{OPENCODE_CONTEXT_DIR}}` | 你的 opencode 配置目录 | opencode 全局配置位置 |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 服务地址 |
| `OLLAMA_EXE` | `ollama` | Ollama 可执行文件路径 |
| `OLLAMA_MODELS_DIR` | 留空（Ollama 默认） | Ollama 模型目录 |
| `OPENCODE_VISION_TMP` | 系统临时目录 | vision 插件临时文件目录 |
| `OLLAMA_PROXY_SCRIPT` | 临时目录内自动生成的代理脚本 | vision 插件 /v1 代理脚本 |

## 快速开始

在 opencode 中切换到 `research-mentor` agent 后，直接说出你的需求：

- "帮我做个选题" / "这个方向有什么研究热点？"
- "把这些文献整理到我的 Obsidian 文献库"
- "帮我查一下这些引用是否正确"
- "把我的草稿润色成 Nature 风格"
- "模拟 3 位审稿人审一下我的论文"

科研导师会按流程自动调度对应的技能包、MCP 服务与本地工具。

## 许可证

MIT License