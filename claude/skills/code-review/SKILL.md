---
name: code-review
description: "Code review and adversarial self-review techniques. Use when reviewing pull requests, providing code feedback, critiquing code quality, or when the user asks for harsh, adversarial, or critical review of plans or code."
---

## Code Review Priorities

When reviewing code, prioritize in this order:

1. **Correctness** — Does it do what it's supposed to? Are there logic errors, off-by-ones, race conditions?
2. **Security** — OWASP top 10, injection vulnerabilities, auth/authz issues, data exposure
3. **Edge cases** — What happens with empty inputs, null values, concurrent access, network failures?
4. **API design** — Is the interface intuitive? Will it be easy to use correctly and hard to misuse?
5. **Error handling** — Are errors caught, reported clearly, and recoverable where possible?
6. **Maintainability** — Will another developer understand this in 6 months?
7. **Style** — Naming, formatting, consistency (lowest priority — don't bikeshed)

## Structured Feedback

Use severity levels to help the author prioritize:

- **Blocking** — Must fix before merge. Bugs, security issues, data loss risks.
- **Should fix** — Strong recommendation. Design issues, missing error handling, unclear API.
- **Suggestion** — Take it or leave it. Alternative approaches, style preferences, minor improvements.
- **Question** — Not necessarily a problem, but needs clarification. "Why this approach?" or "Did you consider X?"

Make every comment actionable — explain what's wrong AND what to do about it.

## When to Approve vs Request Changes

- **Approve**: No blocking issues. Suggestions and questions can be addressed in follow-up.
- **Request changes**: Blocking issues exist. Be specific about what needs to change.
- **Don't block on style**: If the code works correctly and is maintainable, style disagreements aren't worth blocking.

## Adversarial Self-Review

An adversarial loop is a self-review technique where you spawn a harsh critic agent to find flaws in your work, then filter that feedback for genuinely useful insights.

### When to Use

- **Proactively** for hard problems: complex architectural decisions, tricky edge cases, security-sensitive code
- **On demand** when the user requests it (e.g., "use an adversarial loop to review this plan")

**Token warning**: This technique churns through tokens quickly. Reserve it for work that genuinely benefits from rigorous review.

### The Loop

1. **Present** your plan or commits
2. **Spawn harsh critic agent** that does everything in its power to find flaws — the more damning and obvious the issue, the better. The critic should use notes, web searches, and independent research to back up claims.
3. **Critic returns review** with findings
4. **Filter the feedback** — look for issues that are:
   - Actually valid (not hallucinated)
   - Relevant to the current work (though major issues unrelated to your work may still be worth flagging)
5. **Revise** based on valid feedback:
   - For plans: update the plan
   - For commits: amend if not pushed, otherwise create new commits for each fix

### Interpreting Results

If the adversarial agent starts hallucinating issues or nitpicking trivialities, that's a signal your work is solid. The goal isn't to find problems — it's to surface problems that actually exist. A review that finds nothing damning is a successful review.
