# Simplex

Simplex is a spaced-repetition flashcard app built with React, TypeScript, Tailwind CSS, and Framer Motion. It schedules reviews with the SM-2 algorithm, can generate quiz cards from a deck using the Gemini API, and supports both guest (local-only) and signed-in (Firebase) usage.
- The URL : https://simplexflashcards.netlify.app/

## Features

- **SM-2 spaced repetition** — review scheduling based on the classic SuperMemo-2 algorithm, adjusting each card's interval and ease factor from your recall quality.
- **AI-generated quizzes** — turn an existing deck into a quiz using Google's Gemini API, with results cached locally per deck.
- **Guest mode** — use the app fully offline with no account; decks and cards are stored in `localStorage`.
- **Account sync** — sign in with email/password (Firebase Authentication) to back up and sync decks/cards to Firestore.
- **Deck sharing** — share decks publicly or with specific users (requires Firebase to be configured).
- **Import/export** — back up or move your data as a JSON file.
- **Light/dark mode**, responsive layout, and a 3D-tilt hero card on desktop.

## Tech stack

- [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) for dev/build tooling
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Framer Motion (`motion`)](https://motion.dev/) for animation
- [Firebase](https://firebase.google.com/) (Authentication + Firestore) — optional, for accounts/sync
- [Gemini API](https://ai.google.dev/) — optional, for AI-generated quizzes
- [shadcn/ui](https://ui.shadcn.com/) + [Radix UI](https://www.radix-ui.com/) primitives
- [lucide-react](https://lucide.dev/) icons

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (or pnpm/yarn, adjusting commands accordingly)

### Install

```bash
npm install
```

### Run the dev server

```bash
npm run dev
```

This starts Vite's dev server (default: `http://localhost:5173`).

### Build for production

```bash
npm run build
```

Output is written to `dist/`.

## Configuration

Guest mode (no account, local storage only) works out of the box with no configuration. Two optional integrations are configured directly in `src/app/App.tsx`:

### Firebase (accounts, sync, deck sharing)

1. Create a project at the [Firebase console](https://console.firebase.google.com).
2. Enable **Authentication** → Sign-in method → **Email/Password**.
3. Enable **Firestore Database** (test mode is fine to start).
4. Go to **Project Settings → Your apps → Web**, register an app, and copy the resulting config object.
5. In `src/app/App.tsx`, replace the placeholder values in `FIREBASE_CONFIG` near the top of the file with your own project's values.

Until configured, the app runs in guest-only mode and any sign-in/sharing action will show a "Firebase not configured" message instead of failing silently.

### Gemini API (AI quiz generation)

1. Get an API key from [Google AI Studio](https://aistudio.google.com/).
2. In `src/app/App.tsx`, set `GEMINI_API_KEY` to your key.

> **Note:** the app currently calls `generativelanguage.googleapis.com` directly from the browser using this key. That's fine for local development, but it exposes the key to anyone who opens dev tools once deployed. For production, route quiz generation through a small server-side proxy (e.g. a serverless function) instead of calling Gemini directly from the client.

### ⚠️ Before pushing to a public repo

This project was exported from Figma Make, and `src/app/App.tsx` may still contain real Firebase and/or Gemini API keys checked in as placeholder values. **Rotate any keys that were committed and move them out of source control** before making the repository public — for example, by loading them from environment variables (`import.meta.env.VITE_FIREBASE_API_KEY`, etc. with Vite) and adding a `.env` file to `.gitignore`.

## Project structure

```
src/
├── app/
│   ├── App.tsx                  # Main app: hero/landing, auth, sidebar, study flow, decks, AI quiz
│   └── components/
│       ├── ui/                  # shadcn/ui-based primitives (button, dialog, sidebar, etc.)
│       └── figma/                # Figma-export helper components
├── styles/                      # Tailwind entry, theme tokens, fonts
└── main.tsx                     # App entry point
```

## License

No license file is currently included. Add one (e.g. MIT) if you intend to make this repository public.

## Acknowledgements

See [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) for third-party components and assets used in this project.
