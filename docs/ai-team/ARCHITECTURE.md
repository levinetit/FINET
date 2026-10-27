# FINET AI Team — arhitectură tehnică

## 1. Obiectiv

Un flux de lucru cu șapte roluri specializate în Claude Code: coordonare, cercetare, analiză, planificare, implementare, securitate și verificare. Cercetarea este paralelă și read-only; modificările sunt etapizate, cu un singur agent de implementare pentru un set de fișiere dat; integrarea rămâne sub control uman.

## 2. Fapte verificate și limite

La auditul de configurare, repository-ul public `levinetit/FINET` are `main` ca branch implicit și conține `CLAUDE.md`, `README.md` și documentație FINET. `CLAUDE.md` cere deja: o fază pe sesiune, branch dedicat și PR către `main`, fără secrete, sume ca numere întregi și raportarea comenzilor reale. `docs/FINET_MASTER_PROMPT.md` descrie arhitectura-țintă, dar documentația nu dovedește că toate modulele sunt implementate.

La verificarea prin GitHub Contents API, `package.json` și `docs/ROADMAP.md` nu au fost găsite la căile respective. Acest lucru trebuie reconfirmat din checkout-ul local; nu presupune că există cod aplicație, teste sau scripturi care nu au fost inspectate.

## 3. Modelul echipei

| Rol | Agent | Mod | Drepturi recomandate | Livrabil |
|---|---|---|---|---|
| Coordonator | `coordinator` | plan | read-only; parent session orchestrează | task brief, delegare, decizie de integrare |
| Cercetător | `researcher` | read-only | citire + comenzi locale read-only | audit factual |
| Analist | `analyst` | read-only | citire | cerințe, invariants, edge cases |
| Planificator | `planner` | read-only | citire | task plan și test matrix |
| Programator | `programmer` | write, numai pe task aprobat | editare + teste locale | implementare și teste |
| Securitate | `security` | read-only | citire + verificări locale sigure | constatări cu severitate |
| Verificator | `verifier` | read-only | citire + teste locale sigure | verdict QA independent |

Notă de implementare: în Claude Code, agentul coordonator este ghidul de rol și raportare. Sesiunea principală Claude Code este cea care lansează agenții nativi, le transmite rezultatele și păstrează controlul asupra integrării; un subagent nu trebuie tratat ca manager autonom al celorlalți subagenți.

## 4. Flux logic

```text
Cerere + scope
      |
      v
Coordinator / main session
      |
      +---- parallel, read-only ----> Researcher
      +---- parallel, read-only ----> Analyst
      +---- parallel, read-only ----> Security (dacă e relevant)
      |
      v
Coordinator reconciles evidence
      |
      v
Planner creates staged tasks + acceptance gates
      |
      v
Human confirms scope / risky design
      |
      v
Programmer implements one bounded task
      |
      +----> Security independent review
      +----> Verifier independent QA
      |
      v
Coordinator summarizes evidence and diff
      |
      v
HUMAN APPROVAL REQUIRED
      |
      +---- approve PR/integration
      +---- request changes -> Programmer -> repeat reviews
```

## 5. Single source of truth

- `CLAUDE.md` remains the short entry point and links to the canonical FINET master prompt.
- `docs/FINET_MASTER_PROMPT.md` remains authoritative for product, money, privacy, infrastructure and phase rules.
- `docs/FINET_ANDROID_MASTER_PROMPT.md` governs mobile-specific work.
- `docs/GHID_CONSTRUIRE.md` governs operator-only infrastructure steps.
- `docs/ai-team/` governs collaboration, agent roles and quality gates only. It must not duplicate or override business rules.
- If `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/API.md` or `docs/openapi.json` are absent, report the gap and ask whether to create/update them in the relevant approved phase.

## 6. Change isolation

- Research, analysis, planning, security review and verification are read-only.
- One programmer owns a task at a time.
- Parallel implementation is permitted only for disjoint files with agreed interfaces; do not parallelize shared schema/API changes without a clear owner.
- Use a dedicated branch and PR. Never push directly to `main`.
- Never stage/commit/push/merge/deploy unless explicitly authorized by the operator.
- Preserve existing uncommitted changes.
