---
name: academic-research-suite
description: >
  学术研究工作流：深度研究、文献综述、系统综述、论文撰写、审稿、引用检查、研究到论文流水线及实验规划。用于研究任务、论文工作流、ARS 别名和实验设计。
metadata:
  adapter_runtime: universal
  managed_by: academic-agent-toolkit
---

# Academic Research Suite

Use this skill as a router. Do not load the full suite by default. Read one workflow entrypoint from `ars/`, then load only the files needed for the current phase.

| Intent | Read first |
|---|---|
| Deep research, literature review, systematic review, meta-analysis, fact checking, research question refinement | `ars/deep-research/WORKFLOW.md` or `ars/deep-research/SKILL.md` |
| Paper writing, outline, abstract, revision, citation formatting, AI disclosure, format guidance | `ars/academic-paper/WORKFLOW.md` or `ars/academic-paper/SKILL.md` |
| Peer review simulation, editorial decision, review calibration | `ars/academic-paper-reviewer/WORKFLOW.md` or `ars/academic-paper-reviewer/SKILL.md` |
| End-to-end research-to-paper workflow | `ars/academic-pipeline/WORKFLOW.md` or `ars/academic-pipeline/SKILL.md` |
| Experiment planning, study protocol, statistical interpretation, reproducibility validation | `ars/experiment-agent/WORKFLOW.md` or `ars/experiment-agent/SKILL.md` |

If the user has only a broad paper topic or tentative title without a clear research question, route to the `ars/deep-research` entrypoint in Socratic mode first and ask 3-5 narrowing questions.

Alias routing: treat `/ars-*` and `ars-*` command names as prompt recipes under `ars/commands/`, then route to the matching workflow. If slash-prefixed input is reserved by the client, tell the user to use the plain alias form.

Runtime mapping: upstream ARS agent/team references are role prompts to execute inline unless the current client has native subagent delegation and the user explicitly asks for delegation or parallel agents. Use Paper Search MCP for current literature retrieval, DOI/PDF checks, and source verification.
