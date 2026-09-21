---
name: nature-shared
description: 已安装的 nature-writing、nature-polishing、nature-reader 和 nature-paper2ppt 技能的内部共享参考支持包。不可作为独立用户工作流调用，仅按其他 Nature 技能的需求加载指定的 core 或 journal-format 文件。
---

# Nature Shared References

Use this package only as a dependency of another installed Nature skill.

- Load the exact referenced file; do not preload the whole package.
- Treat `core/` and `journal-formats/` as shared definitions, not standalone workflows.
- Use `journal-formats/nature.md` only for the flagship journal Nature and
  `core/research-compliance.md` only when its specialist applicability gate is
  triggered.
- Use `journal-formats/nature-machine-intelligence.md` for exact NMI article
  types, limits, initial-submission files, data/code duties and production
  requirements; do not import flagship Nature or Nature Communications limits.
- Return to the requesting skill for task logic, output format, and final QA.
