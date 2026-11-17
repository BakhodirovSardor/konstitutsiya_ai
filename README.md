# Konstitutsiya AI

A small Node.js website for learning about the Constitution of the Republic of Uzbekistan. It contains:

- The original Uzbek Latin constitutional text for all 155 articles.
- Uzbek Cyrillic display using local Latin-to-Cyrillic transliteration.
- Russian and English article text loaded from the corresponding Lex.uz pages and cached on the server.
- An optional situation-based constitutional information chatbot. It retrieves potentially relevant articles and asks an AI model to explain them in the selected language.

## Requirements

- Node.js 20 or newer
- An internet connection on the server to fetch the Russian and English Lex.uz source pages
- An OpenAI API key to enable the AI chatbot and on-demand translation of educational explanations

## Run locally

1. Open a terminal in this folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env`.
4. Ask a parent, teacher, or site administrator to configure `OPENAI_API_KEY` in `.env` if the AI chatbot is to be enabled. Do not put the API key in `public/index.html`, send it in a chat, or commit `.env` to Git.
5. Start the server:

   ```bash
   npm start
   ```

6. Open <http://localhost:3000>.

The website can serve Uzbek Latin, Uzbek Cyrillic, Russian, and English constitutional article text without an OpenAI key, provided the Node server can reach Lex.uz. The chatbot and AI-translated educational commentary remain disabled until the server administrator configures an API key.

## Environment variables

```env
OPENAI_API_KEY=            # Required for AI features; server-side only
OPENAI_MODEL=gpt-6-luna  # Optional; defaults to gpt-6-luna
PORT=3000                  # Optional; defaults to 3000
DAILY_AI_LIMIT=100          # Optional; maximum AI requests per day across the site
```

## Language and legal-text notes

- Uzbek Latin is the local source dataset in `data/articles-uz.json`.
- Uzbek Cyrillic is generated with deterministic transliteration. Transliteration is not a separately published official Cyrillic edition and some unusual names or loanwords may need editorial correction.
- Russian and English legal text are fetched from the matching 2023 Lex.uz versions and cached in `cache/`. English is explicitly marked by Lex.uz as an unofficial translation. Always show the source notice and link in the UI.
- The article's official text and the AI-generated educational explanation are deliberately displayed separately. AI commentary is not an official legal text.

## Chatbot limitations and safety

The chatbot is an educational information tool, not a lawyer, court, or government service. Its article retrieval is a lightweight keyword-and-topic matching system, not a legal expert system. It can miss relevant provisions or misunderstand facts. It must describe possible relevance, avoid declaring that a violation is proven, and recommend safe, lawful next steps. Users should not enter names, addresses, phone numbers, passport numbers, school names, or other identifying details. For serious situations, users should contact a qualified lawyer or appropriate trusted adult/authority.

The API uses `store: false` for Responses API requests. The app itself keeps the current chat history in page memory only; it does not save chat history to its own database. Hosting providers may still have their own operational logs. The server also applies a basic per-IP rate limit and a configurable daily AI request cap (`DAILY_AI_LIMIT`). These are safeguards for a prototype, not a substitute for hosting-provider usage limits. Monitor API spending before making the chatbot public.

## Deployment

This is not a static-only HTML deployment. The `/api/*` endpoints require the Node.js server. Deploy it to a host that supports Node.js and set environment variables in the host's private settings. Do not publish `.env` or expose `OPENAI_API_KEY` to browser code.
