---
name: visual-review
description: "Review rendered UI, screenshots and interaction flows against agreed design and user needs. Use for appearance, responsive layouts, accessibility, visual states and task-related UX finishing work."
---

# Visual and UX review

Review what users see and do, not just what source or a screenshot filename suggests. Use this perspective in implementation or Claim Reviewer work when the assignment concerns appearance or interaction. It does not add a Designer seat or require a separate review for every task.

## Establish the target and evidence

Read the agreed design, relevant existing patterns and selected states. Identify the actual revision, viewport, device/input conditions and capture path. Use supplied rendered evidence or the authorized capture/check method. If screenshots or interactive access are unavailable, report what cannot be judged; source inspection alone does not confirm visible correctness.

Compare baselines only when they represent the agreed design and equivalent conditions. A snapshot records appearance; it does not decide whether that appearance is desirable or prove the interaction works.

## Review the experience

- **Visual correctness:** layout, hierarchy, alignment, spacing, typography, clipping, layering and legibility.
- **Consistency:** reuse of meaningful design tokens, component patterns and visual emphasis. Explain the relevant comparison rather than enforcing an arbitrary pixel preference.
- **Flow and states:** navigation, affordances, feedback and loading/error/empty/disabled states that belong to the agreed behavior.
- **Responsiveness:** useful narrow/wide layouts, overflow, wrapping, zoom and content variation. Do not infer mobile correctness from a desktop screenshot.
- **Accessibility:** readable text, contrast, visible focus, target sizes and information not conveyed by color alone. Images cannot prove semantics, keyboard order or assistive-technology behavior; inspect those through the assigned checks and label evidence limits.
- **Motion and input:** transitions, reduced-motion behavior and relevant keyboard/pointer/touch paths. Browser simulation is not physical-device or trackpad equivalence.

## Make findings actionable

Cite the screen/state and visible evidence. Explain the user consequence and a correction grounded in the project's design. Distinguish criteria blockers, nonblocking findings and optional UX niceties; missing optional screenshots are not automatically acceptance failures.

Use the smallest useful visual/state check to guard a material regression. Do not turn every detail into a golden snapshot suite or add whole-product redesign to a finishing timebox. See [testing](../testing/SKILL.md) for risk and evidence selection.

Capture, preview startup, screenshot tools, source edits and cleanup still require the assignment's authority. This skill does not provide browser/image tools, a live-service grant or a new test fixture.
