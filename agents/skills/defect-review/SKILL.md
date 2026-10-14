---
name: defect-review
description: "Investigate one named defect class across an explicitly scoped surface, such as races, resource leaks, injection or validation bypasses. Use for focused adversarial review, not a general hardening sweep."
---

# Focused defect review

Choose exactly one defect class and a scoped surface with the orchestrator. Go deeper into that failure mechanism rather than broadening to every possible bug. This is an optional investigation mode for Scout, Worker or Claim Reviewer, not another role or a routine delivery gate.

## Map the reachable surface

List relevant entry points, assumptions, state transitions, callers and trust/resource boundaries. Read real behavior and consumer wiring. Note accepted residuals and exclusions; a boundary disagreement belongs in a separate observation, not silently expanded scope.

Ask what inputs, ordering or external behavior could actually reach the suspected failure. Prefer a small explanation of its consequence to a speculative infrastructure exercise.

## Establish the evidence level

- **Confirmed:** an authorized reproduction shows the named failure, with producing input, source/revision and observed output.
- **Source-supported concern:** a concrete reachable mechanism is visible, but a reproduction has not been executed. Explain the reasoning and what remains unknown.
- **Plausible:** a hypothesis worth a targeted check, not a proven defect.

Do not promote a source pattern or documentation claim into empirical evidence. When an assumption involves git, ssh, a parser or another external tool, use actual behavior where the assignment permits it. If evidence is unavailable, propose the smallest check instead of inventing a pass or failure.

## Probes need authority and ownership

A read-only review does not permit source mutation, a new workspace, live services, credentials or outward/network operations. An experiment requires an explicitly allowed scope, uniquely owned data/paths, enforceable isolation where appropriate and a restoration/closure plan.

Preserve the adverse evidence. Restore through the permitted path, verify the restored source/state and observe actual process/wrapper closure before releasing resources. Never reset shared work, clear predictable directories or delete another person's artifacts to obtain 'zero residue'. Isolation itself is not permission.

## Report coverage and findings

Return the class and scope, surfaces considered, finding status, source/reproduction anchors, reachable blast radius and the smallest correction or next check. Keep out-of-scope observations separate and prioritize actual consequence.

Finding nothing is legitimate when the covered surface and limits are explicit; it is not proof that the entire system is defect-free. Do not fabricate severity, duplicate general-review findings or demand broad refactoring for a narrow correction. See [testing](../testing/SKILL.md) for proportionate regression checks.
