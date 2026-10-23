# Contributing

Design, structure and tests are described in [docs/DESIGN.md](docs/DESIGN.md). This file holds the rules for comments and documentation; `bench/tests/test_comment_conventions.py` checks the mechanical ones.

## Comments and documentation

Write for a reader who has only this repository.

1. **No references to documents outside the repository.** No planning notes, hand-over notes or their section numbers (`PLAN…`, `§3.2` of such a note, `阶段…`, `交接`). Point to a file or a section in this repository (e.g. docs/DESIGN.md "Pre-action checks"), or say the reason in the comment itself.
2. **No internal milestone or review codes.** `R1`–`R6`, `P1`–`P5`, `C1`–`C6`, "round 17", "第七轮" and the like mean nothing outside the maintainer's notes: say what was decided or observed. The one exception is **R5**, the benchmark round whose plan and data are in `bench/` (`bench/r5/`, `bench/results/r5-*.md`, `bench/results/comparison.md`); it may be named there.
3. **State decisions and observations, not who made them.** Not "(the maintainer, 2026-10-17)", but what was decided and, when it helps, when: "(decided 2026-10-17: every button is traceable)". "The maintainer" may name a role in a step a person performs (granting a permission by hand, proofreading ground truth), never as the authority for a decision.
4. **Dates are stamps on facts.** Write them as YYYY-MM-DD, next to what was observed or decided on that day ("VM test, 2026-10-17: …"), never on their own.
5. **No personal data.** No names, accounts, home paths of real people, addresses or numbers; the pre-push hook refuses the common forms (`scripts/hooks/pre-push`).
