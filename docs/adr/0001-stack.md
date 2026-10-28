# ADR 0001 — Stack-ul FINET și versiunile efective

- **Stare:** acceptat (Faza 0)
- **Data:** 2026-10-27
- **Context:** master prompt 3.2 fixează stack-ul; Faza 0 alege versiunile concrete. Versiunile „cele mai noi” au fost verificate cu `npm view` pe 2026-10-27; unde o combinație nu funcționează, s-a coborât la ultima versiune compatibilă.

## Decizie

Stack-ul din master prompt 3.2 rămâne neschimbat, cu o singură abatere de infrastructură (deploy în Docker pe VPS, nu nativ pe LXC 1999), descrisă în [ADR 0002](0002-deploy-docker-pe-vps.md).

### Instalat în Faza 0 (versiuni exacte, `pnpm-lock.yaml` commis)

| Componentă | Versiune | Notă |
|---|---|---|
| Node.js | 24 (`.nvmrc`; imaginea Docker `node:24.22.1-bookworm-slim`) | `engines: >=24.7 <25` (F1-B: `crypto.argon2`, ADR 0003) |
| pnpm | 12.15.0 (prin corepack, `packageManager`) | `allowBuilds: unrs-resolver: false` în `pnpm-workspace.yaml` |
| Next.js | 16.4.3 | App Router, `output: "standalone"`; `middleware.ts` → `src/proxy.ts` (redenumit în Next 16) |
| React / React DOM | 19.3.1 | |
| TypeScript | **6.0.3** (nu 7.0.2) | vezi abaterile |
| Tailwind CSS | 4.3.3 (`@tailwindcss/postcss` 4.3.3) | tokenii FINET în `src/app/globals.css` |
| ESLint | **9.39.5** (nu 10.13.0) | `eslint-config-next` 16.4.3, `eslint-config-prettier` 10.1.8 |
| Prettier | 3.9.10 | |
| Vitest | 5.0.5, cu **vite 8.3.5** fixat | `@vitest/coverage-v8` 5.0.5 (T4) |
| Playwright | 1.64.1 (`@playwright/test`) | browserele nu sunt instalate în mediul agentului |
| Zod | 4.6.7 | `src/lib/config.ts` |
| jose | 6.2.13 | verificarea JWT Cloudflare Access |
| postgres (driver) | 3.4.9 | doar verificarea `db` din `/api/health` |
| server-only | 0.0.1 | marchează modulele de server |
| clsx / tailwind-merge | 2.1.1 / 3.7.0 | `src/lib/utils.ts` (`cn`) |
| Fonturi | `next/font/local` (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono, OFL) | servite local, nu de pe CDN |

### Decis, dar NEINSTALAT încă (vin în fazele lor)
Drizzle ORM / Drizzle Kit (Faza 1), Better Auth (Faza 1), pg-boss (Faza 5/6), shadcn/ui (doar `components.json`, nicio componentă), Recharts (Faza 3), lucide-react (configurat ca bibliotecă de iconițe, neinstalat), Nodemailer, sharp, clientul S3 (Faza 6). Versiunile lor se fixează când sunt adăugate.

## Abateri de versiune și motivele lor
- **TypeScript 6.0.3 în loc de 7.0.2:** `typescript-eslint` (adus de `eslint-config-next`) declară `typescript <6.1.0` ca peer dependency.
- **ESLint 9.39.5 în loc de 10.13.0:** pluginurile `eslint-plugin-react`, `eslint-plugin-import` și `eslint-plugin-jsx-a11y` (din `eslint-config-next`) declară peer doar `eslint ^9`.
- **vite 8.3.5 fixat explicit:** peer dependency al Vitest 5; fixat ca rezolvarea să nu varieze.
- **pnpm `allowBuilds: unrs-resolver: false`:** pnpm 12 blochează implicit scripturile de instalare; scriptul `unrs-resolver` doar descarcă o variantă WASM de rezervă, binarul nativ vine ca dependență opțională.
- **`.prettierignore` exclude `**/*.md`, `docs/` și `.claude/`:** documentele canonice și Markdown-ul nu se reformatează automat.
- **`@vitest/coverage-v8` 5.0.5:** aceeași versiune ca Vitest (pachetele trebuie să coincidă). Fără prag impus în CI în Faza 0.

## Consecințe
- La trecerea `typescript-eslint` la suport pentru TypeScript 7 și a pluginurilor la ESLint 10, se face upgrade într-un PR separat (Dependabot e configurat în `.github/dependabot.yml`).
- Orice schimbare a stack-ului (nu doar a versiunii) cere un ADR nou.
