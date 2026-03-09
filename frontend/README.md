# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Encrypted Chat Diagnostic

There is a focused Playwright diagnostic for live encrypted DM delivery in real browser contexts:

```bash
PLAYWRIGHT_BASE_URL="https://social-network-gemma-053a8f6650ab.herokuapp.com" \
PLAYWRIGHT_CHAT_INVITE_CODE_ALICE="alice-invite-code" \
PLAYWRIGHT_CHAT_INVITE_CODE_BOB="bob-invite-code" \
npm run playwright:chat-live
```

It creates two fresh users, establishes friendship over the API, logs both users into separate browser contexts, sends an encrypted DM from Alice to Bob, sends Bob's reply, reloads Alice, and records whether the reply still decrypts. The run writes screenshots and a JSON report under `frontend/playwright-results/`.
