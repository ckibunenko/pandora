# Pandora

Pandora is a B2B order and inventory management platform for a fictional board-game distributor, built to showcase Senior QA skills through a working application and automated tests.

## Context Files

Read the followting go get the full context of the project:

- @context/project-overview.md
- @context/coding-standards.md
- @context/ai-interaction.md
- @context/current-feature.md


## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — ESLint (flat config via `eslint-config-next`)

There is no test suite in this project yet.

## Architecture

- Next.js App Router (`src/app`), TypeScript, React 19.
- `src/app/layout.tsx` is the root layout; it loads the Geist Sans/Mono fonts via `next/font/google` and exposes them as CSS variables (`--font-geist-sans`, `--font-geist-mono`).
- Styling is Tailwind CSS v4, configured entirely in CSS via `@import "tailwindcss"` and `@theme inline` in [src/app/globals.css](src/app/globals.css) — there is no `tailwind.config.*` file.
- Path alias `@/*` maps to `src/*` (see [tsconfig.json](tsconfig.json)).
- [public/](public/) holds static assets served from `/`.
