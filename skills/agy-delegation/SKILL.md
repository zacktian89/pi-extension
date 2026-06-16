---
name: agy-delegation
description: Workflow for using Antigravity/agy delegation. Use when a task needs broad web research, repository exploration, multi-file codebase understanding, complex planning, debugging, review, or second-opinion analysis.
---

# agy Delegation

## Purpose

Use `agy_delegate` as a read-only research/exploration assistant. Pi remains responsible for final edits, verification, and user-facing conclusions.

## When to delegate

Use agy for:

- Web or documentation research.
- Ecosystem/library comparison.
- Broad repository exploration.
- Understanding cross-file architecture or flows.
- Complex debugging or planning.
- Refactor risk analysis.
- Test strategy or second-opinion review.

Avoid agy for:

- Simple file reads.
- Trivial edits.
- Direct short answers.
- Localized symbol lookup that CodeGraph or `read` can solve quickly.

## Default tool settings

Use read-only mode by default:

```json
{
  "allowWrites": false,
  "permissionMode": "default"
}
```

Only allow writes if the user explicitly requests it or approves it.

## Recommended modes

- `mode="review"`: second opinion, code review, general investigation.
- `mode="plan"`: implementation/refactor planning.
- `mode="debug"`: debugging hypotheses and investigation.
- `mode="test"`: test strategy or coverage suggestions.
- `mode="implement"`: only when writes are intentionally allowed.

## After agy returns

1. Use agy's findings to narrow local follow-up.
2. Verify important claims with targeted reads or commands when needed.
3. Make final code edits in Pi.
4. Run verification locally where appropriate.
5. Summarize clearly to the user.

## Research task requirements

When delegating web, documentation, ecosystem, industry-practice, or best-practice research to agy, include source requirements in the delegated task:

- Ask agy to cite public URLs or authoritative references when available.
- Ask agy to distinguish sourced facts from its own synthesis or recommendations.
- Ask agy to note any claims that could not be verified.
- Prefer direct documentation, official blogs, standards/specs, release notes, GitHub permalinks, or primary-source material over generic summaries.

## Research policy

If agy gives a usable research result, do not do additional web searches.

A research result is considered usable when it contains enough specific evidence for the user's request, such as URLs, citations, file paths, or reproducible references.

Second-pass lookup is allowed only when:

- the user explicitly asks for more sources or independent verification,
- agy's answer lacks citations/URLs for a research-heavy question,
- agy's result is incomplete,
- agy's result looks suspicious,
- or verification is necessary before making a recommendation.

Before doing a second-pass lookup, briefly explain why.
