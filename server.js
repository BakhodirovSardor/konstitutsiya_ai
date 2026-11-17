
import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIGURATION
// ============================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT) || 100;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, 'cache');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles-uz.json');

const CONSTITUTION_URLS = {
  ru: 'https://lex.uz/ru/docs/6451070',
  en: 'https://lex.uz/en/docs/6451070'
};

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

app.use(express.json({ limit: '180kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ============================================================
// INITIALIZATION
// ============================================================

await fs.mkdir(CACHE_DIR, { recursive: true });

let uzbekArticles = [];

function normalizeArticleData(data) {
  // Already an array.
  if (Array.isArray(data)) {
    return data;
  }

  // Object containing an articles array.
  if (data && Array.isArray(data.articles)) {
    return data.articles;
  }

  // Object with numbered keys:
  // { "1": "Article text", "2": "Article text" }
  if (data && typeof data === 'object') {
    const entries = Object.entries(data)
      .filter(([key]) => /^\d+$/.test(key))
      .sort((a, b) => Number(a[0]) - Number(b[0]));

    if (entries.length === 0) {
      throw new Error('No numbered articles found in JSON.');
    }

    return entries.map(([number, content]) => {
      if (typeof content === 'string') {
        return {
          number: Number(number),
          title: `O‘zbekiston Respublikasi Konstitutsiyasi ${number}-modda`,
          text: content
        };
      }

      if (content && typeof content === 'object') {
        return {
          ...content,
          number: Number(number)
        };
      }

      throw new Error(`Invalid content for article ${number}.`);
    });
  }

  throw new Error('Unsupported articles JSON structure.');
}

try {
  const raw = await fs.readFile(ARTICLES_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  uzbekArticles = normalizeArticleData(parsed);

  if (uzbekArticles.length === 0) {
    throw new Error('No articles were loaded.');
  }

  console.log(`Loaded ${uzbekArticles.length} Uzbek articles.`);

} catch (error) {
  console.error('Could not load articles-uz.json:', error.message);
  console.error('Check data/articles-uz.json.');
  process.exit(1);
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/o'/g, 'o')
    .replace(/g'/g, 'g');
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function getLanguageName(language) {
  const languages = {
    uz_lat: 'Uzbek Latin',
    uz_cyr: 'Uzbek Cyrillic',
    ru: 'Russian',
    en: 'English'
  };

  return languages[language] || 'Uzbek Latin';
}

function getArticleNumber(article) {
  if (!article || typeof article !== 'object') {
    return null;
  }

  const candidates = [
    article.number,
    article.article,
    article.articleNumber,
    article.id,
    article.title
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;

    const match = String(candidate).match(/\d+/);

    if (match) {
      return Number(match[0]);
    }
  }

  return null;
}

function getArticleText(article) {
  if (typeof article === 'string') {
    return article;
  }

  if (!article || typeof article !== 'object') {
    return '';
  }

  return [
    article.title,
    article.name,
    article.heading,
    article.text,
    article.content,
    article.body,
    article.description,
    article.explanation,
    article.simplified,
    article.summary
  ]
    .filter(Boolean)
    .map(value =>
      typeof value === 'string'
        ? value
        : JSON.stringify(value)
    )
    .join(' ');
}

function getArticleTitle(article) {
  if (typeof article === 'string') {
    return 'Article';
  }

  return (
    article?.title ||
    article?.name ||
    article?.heading ||
    `Article ${getArticleNumber(article) ?? ''}`
  );
}

function withTimeout(promise, milliseconds, message) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
  });

  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timer));
}

// ============================================================
// HTML HELPERS
// ============================================================

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// ============================================================
// UZBEK LATIN TO CYRILLIC
// ============================================================

function uzLatinToCyrillic(input) {
  let text = String(input ?? '');

  const special = [
    [/sh/gi, 'ш'],
    [/ch/gi, 'ч'],
    [/yo/gi, 'ё'],
    [/yu/gi, 'ю'],
    [/ya/gi, 'я'],
    [/o['’ʻʼ`]/gi, 'ў'],
    [/g['’ʻʼ`]/gi, 'ғ']
  ];

  for (const [pattern, replacement] of special) {
    text = text.replace(pattern, match =>
      match[0] === match[0].toUpperCase()
        ? replacement.toUpperCase()
        : replacement
    );
  }

  const map = {
    a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф',
    g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к',
    l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
    q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у',
    v: 'в', x: 'х', y: 'й', z: 'з',

    A: 'А', B: 'Б', D: 'Д', E: 'Е', F: 'Ф',
    G: 'Г', H: 'Ҳ', I: 'И', J: 'Ж', K: 'К',
    L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П',
    Q: 'Қ', R: 'Р', S: 'С', T: 'Т', U: 'У',
    V: 'В', X: 'Х', Y: 'Й', Z: 'З',

    ш: 'ш', Ш: 'Ш', ч: 'ч', Ч: 'Ч',
    ё: 'ё', Ё: 'Ё', ю: 'ю', Ю: 'Ю',
    я: 'я', Я: 'Я', ў: 'ў', Ў: 'Ў',
    ғ: 'ғ', Ғ: 'Ғ'
  };

  return [...text].map(char => map[char] ?? char).join('');
}

// ============================================================
// RATE LIMITING
// ============================================================

const requestCounts = new Map();
const dailyAiCounts = new Map();

const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;

function enforceRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  let record = requestCounts.get(ip);

  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count++;
  requestCounts.set(ip, record);

  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute and try again.'
    });
  }

  next();
}

function enforceDailyAiLimit(req, res, next) {
  const ip = getClientIp(req);
  const today = new Date().toISOString().slice(0, 10);
  const key = `${today}:${ip}`;

  const count = dailyAiCounts.get(key) || 0;

  if (count >= DAILY_AI_LIMIT) {
    return res.status(429).json({
      error: 'The daily AI request limit has been reached. Please try again tomorrow.'
    });
  }

  dailyAiCounts.set(key, count + 1);
  next();
}

// ============================================================
// GEMINI
// ============================================================

async function generateGeminiText({
  systemInstruction,
  contents,
  maxOutputTokens = 1000,
  responseMimeType
}) {
  if (!ai) {
    throw new Error('Gemini API is not configured.');
  }

  const config = {
    systemInstruction,
    maxOutputTokens,
    temperature: 0.2
  };

  if (responseMimeType) {
    config.responseMimeType = responseMimeType;
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[GEMINI] Attempt ${attempt}/${maxAttempts}`);

      const response = await withTimeout(
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents,
          config
        }),
        40000,
        'Gemini request timed out after 40 seconds.'
      );

      const result = response.text;

      if (!result || !result.trim()) {
        throw new Error('Gemini returned an empty response.');
      }

      console.log('[GEMINI] Response received.');
      return result.trim();

    } catch (error) {
      const status = Number(error.status || error.code);
      const message = error.message || '';

      console.error('[GEMINI ERROR]', {
        attempt,
        status: status || 'unknown',
        message
      });

      const retryable =
        status === 503 ||
        status === 429 ||
        status === 500 ||
        message.includes('timed out');

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const delay = attempt * 3000;
      console.log(`[GEMINI] Retrying in ${delay / 1000} seconds...`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}


function requireGeminiMiddleware(_req, res, next) {
  if (!ai) {
    return res.status(503).json({
      error: 'The AI assistant is not configured. Please configure GEMINI_API_KEY on the server.'
    });
  }

  next();
}

// ============================================================
// CONSTITUTION TRANSLATIONS
// ============================================================

function parseConstitutionPage(html, language) {
  const text = htmlToText(html);

  const articlePattern = language === 'ru'
    ? /(?:Статья|Модда)\s+(\d+)\s*\.?/gi
    : /Article\s+(\d+)\s*\.?/gi;

  const matches = [...text.matchAll(articlePattern)];
  const articles = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    const start = match.index + match[0].length;

    const end = i + 1 < matches.length
      ? matches[i + 1].index
      : text.length;

    const content = text.slice(start, end).trim();

    if (!content) continue;

    articles.push({
      number: Number(match[1]),
      title: language === 'ru'
        ? `Статья ${match[1]}`
        : `Article ${match[1]}`,
      text: content
    });
  }

  return articles;
}

async function getOfficialTranslation(language) {
  if (!['ru', 'en'].includes(language)) {
    throw new Error('Unsupported translation language.');
  }

  const cacheFile = path.join(
    CACHE_DIR,
    `constitution-${language}.json`
  );

  try {
    const cached = JSON.parse(
      await fs.readFile(cacheFile, 'utf8')
    );

    const age = Date.now() - cached.timestamp;

    if (
      Array.isArray(cached.articles) &&
      cached.articles.length > 0 &&
      age < 7 * 24 * 60 * 60 * 1000
    ) {
      console.log(`[TRANSLATION] Using cached ${language} articles.`);
      return cached.articles;
    }
  } catch {
    // Fetch if cache is missing or invalid.
  }

  console.log(`[TRANSLATION] Fetching ${language} from Lex.uz.`);

  const response = await fetch(CONSTITUTION_URLS[language], {
    headers: {
      'User-Agent': 'KonstitutsiyaAI/1.0'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(
      `Lex.uz returned HTTP ${response.status}.`
    );
  }

  const html = await response.text();
  const articles = parseConstitutionPage(html, language);

  if (articles.length === 0) {
    throw new Error(
      `Could not extract ${language} articles from Lex.uz.`
    );
  }

  await fs.writeFile(
    cacheFile,
    JSON.stringify({
      timestamp: Date.now(),
      articles
    }, null, 2),
    'utf8'
  );

  console.log(`[TRANSLATION] Loaded ${articles.length} ${language} articles.`);

  return articles;
}

// ============================================================
// ARTICLE RETRIEVAL
// ============================================================

const RETRIEVAL_HINTS = [
  {
    keywords: [
      'speech', 'speak', 'opinion', 'expression',
      'fikr', 'gapirish', 'soz', 'nutq',
      'свобода слова', 'мнение', 'выражения',
      'эркин фикр', 'фикр билдириш'
    ],
    articles: [33, 34]
  },
  {
    keywords: [
      'education', 'school', 'study', 'teacher', 'student',
      'talim', 'maktab', 'oqituvchi', 'oquvchi',
      'учеба', 'образование', 'школа', 'учитель'
    ],
    articles: [50, 51, 52]
  },
  {
    keywords: [
      'privacy', 'personal data', 'private', 'phone',
      'shaxsiy', 'maxfiy', 'telefon', 'malumot',
      'личная жизнь', 'персональные данные'
    ],
    articles: [31, 32]
  },
  {
    keywords: [
      'home', 'house', 'dwelling', 'uy', 'xonadon',
      'uyga kirish', 'дом', 'жилище'
    ],
    articles: [31, 32]
  },
  {
    keywords: [
      'equality', 'discrimination', 'equal', 'tenglik',
      'kamsitish', 'teng huquq', 'равенство', 'дискриминация'
    ],
    articles: [19, 20]
  },
  {
    keywords: [
      'work', 'job', 'salary', 'employment', 'mehnat',
      'ish', 'maosh', 'ish haqi', 'труд', 'работа', 'зарплата'
    ],
    articles: [42, 43, 44]
  },
  {
    keywords: [
      'health', 'hospital', 'doctor', 'medical',
      'sogliq', 'shifoxona', 'shifokor',
      'здоровье', 'больница', 'врач'
    ],
    articles: [48, 49]
  },
  {
    keywords: [
      'property', 'ownership', 'money', 'mulk',
      'mol-mulk', 'собственность', 'имущество'
    ],
    articles: [41]
  },
  {
    keywords: [
      'religion', 'belief', 'faith', 'diniy',
      'etiqod', 'religiya', 'религия', 'убеждения'
    ],
    articles: [35]
  },
  {
    keywords: [
      'movement', 'travel', 'leave', 'travel abroad',
      'harakatlanish', 'chet el', 'safar',
      'передвижение', 'выезд'
    ],
    articles: [32]
  },
  {
    keywords: [
      'court', 'lawyer', 'arrest', 'detained',
      'sud', 'advokat', 'hibs', 'ushlab',
      'суд', 'адвокат', 'арест', 'задержание'
    ],
    articles: [29, 30, 137]
  },
  {
    keywords: [
      'internet', 'online', 'information', 'media',
      'axborot', 'malumot olish',
      'интернет', 'информация', 'сми'
    ],
    articles: [33, 34]
  }
];

function retrieveArticles(
  situation,
  language,
  translatedArticles = []
) {
  const sourceArticles =
    language === 'uz_lat' || language === 'uz_cyr'
      ? uzbekArticles
      : translatedArticles;

  if (!Array.isArray(sourceArticles) || sourceArticles.length === 0) {
    console.error('[RETRIEVAL] No source articles available.');
    return [];
  }

  const query = normalizeSearchText(situation);
  const scores = new Map();

  // Keyword-based relevance.
  for (const hint of RETRIEVAL_HINTS) {
    const matched = hint.keywords.some(keyword =>
      query.includes(normalizeSearchText(keyword))
    );

    if (matched) {
      for (const number of hint.articles) {
        scores.set(number, (scores.get(number) || 0) + 5);
      }
    }
  }

  // Explicit article references.
  const numberMatches = query.match(
    /(?:article|modda|статья|статье)\s*(\d+)/gi
  ) || [];

  for (const match of numberMatches) {
    const number = Number(match.match(/\d+/)?.[0]);

    if (number) {
      scores.set(number, (scores.get(number) || 0) + 20);
    }
  }

  // Basic word-overlap scoring.
  const queryWords = new Set(
    query
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2)
  );

  for (const article of sourceArticles) {
    const number = getArticleNumber(article);

    if (!number) continue;

    const articleText = normalizeSearchText(
      getArticleText(article)
    );

    let score = scores.get(number) || 0;

    for (const word of queryWords) {
      if (articleText.includes(word)) {
        score += 1;
      }
    }

    if (score > 0) {
      scores.set(number, score);
    }
  }

  const ranked = sourceArticles
    .map(article => ({
      article,
      number: getArticleNumber(article),
      score: scores.get(getArticleNumber(article)) || 0
    }))
    .filter(item => item.number && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (ranked.length > 0) {
    return ranked.map(item => item.article);
  }

  // General fallback context.
  console.log('[RETRIEVAL] No keyword matches. Using fallback articles.');

  const fallbackNumbers = [19, 20, 21, 25, 26, 33];

  return sourceArticles
    .filter(article =>
      fallbackNumbers.includes(getArticleNumber(article))
    )
    .slice(0, 4);
}

// ============================================================
// EMERGENCY HANDLING
// ============================================================

function isEmergencySituation(text) {
  return /i\s+killed\s+someone|i\s+have\s+killed|someone\s+is\s+seriously\s+injured|someone\s+is\s+unconscious|я\s+убил|я\s+убила|человек\s+погиб|тяжело\s+ранен|odamni\s+o['’‘`]?ldirdim|odam\s+o['’‘`]?ldirdim|odam\s+og['’‘`]?ir\s+jarohatlangan|kimdir\s+hushsiz/i.test(text);
}

function handleEmergency(req, res, next) {
  const situation = normalizeText(req.body?.situation);

  if (!situation || !isEmergencySituation(situation)) {
    return next();
  }

  const language = req.body?.language || 'uz_lat';

  const responses = {
    uz_lat:
      'Bu favqulodda vaziyat bo‘lishi mumkin. Darhol 112 yoki tez yordam uchun 103, politsiya uchun 102 raqamiga qo‘ng‘iroq qiling. Agar kimdir jarohatlangan yoki hushsiz bo‘lsa, dispetcher ko‘rsatmalariga amal qiling. Xavfli joydan uzoqlashing, boshqa hech kimga zarar yetkazmang va voqea joyini yashirish yoki o‘zgartirishga urinmang. Agar voyaga yetmagan bo‘lsangiz, darhol ishonchli katta odamga murojaat qiling. AI javobini kutmang.',

    uz_cyr:
      'Бу фавқулодда вазият бўлиши мумкин. Дарҳол 112 ёки тез ёрдам учун 103, полиция учун 102 рақамига қўнғироқ қилинг. Агар кимдир жароҳатланган ёки ҳушсиз бўлса, диспетчер кўрсатмаларига амал қилинг. Хавфли жойдан узоқлашинг, бошқа ҳеч кимга зарар етказманг ва воқеа жойини яшириш ёки ўзгартиришга уринманг. Агар вояга етмаган бўлсангиз, дарҳол ишончли катта одамга мурожаат қилинг. AI жавобини кутманг.',

    ru:
      'Это может быть чрезвычайная ситуация. Немедленно позвоните 112, в скорую помощь по номеру 103 или в полицию по номеру 102. Если кто-то ранен или без сознания, следуйте инструкциям диспетчера. Отойдите от опасности, не причиняйте никому вреда и не пытайтесь скрывать или изменять место происшествия. Если вы несовершеннолетний, немедленно обратитесь к надёжному взрослому. Не ждите ответа ИИ.',

    en:
      'This may be an emergency. Call 112 immediately, 103 for an ambulance, or 102 for police in Uzbekistan. If someone is injured or unconscious, follow the dispatcher’s instructions. Move away from danger, do not hurt anyone, and do not hide or alter the scene. If you are a minor, contact a trusted adult immediately. Do not wait for an AI response.'
  };

  return res.json({
    answer: responses[language] || responses.uz_lat,
    articlesUsed: [],
    urgent: true
  });
}

// ============================================================
// API: HEALTH CHECK
// ============================================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(ai),
    provider: 'Google Gemini',
    model: GEMINI_MODEL,
    articlesLoaded: uzbekArticles.length
  });
});

// ============================================================
// API: GET CONSTITUTION
// ============================================================

app.get('/api/constitution/:lang', async (req, res) => {
  try {
    const language = req.params.lang;

    if (language === 'uz_lat') {
      return res.json(uzbekArticles);
    }

    if (language === 'uz_cyr') {
      const converted = uzbekArticles.map(article => {
        const result = { ...article };

        for (const key of [
          'title',
          'name',
          'heading',
          'text',
          'content',
          'body',
          'description',
          'explanation',
          'simplified',
          'summary'
        ]) {
          if (typeof result[key] === 'string') {
            result[key] = uzLatinToCyrillic(result[key]);
          }
        }

        return result;
      });

      return res.json(converted);
    }

    if (language === 'ru' || language === 'en') {
      const articles = await getOfficialTranslation(language);
      return res.json(articles);
    }

    return res.status(400).json({
      error: 'Unsupported language. Use uz_lat, uz_cyr, ru, or en.'
    });

  } catch (error) {
    console.error('[CONSTITUTION ERROR]', error.message);

    return res.status(500).json({
      error: 'Could not load the Constitution. Please try again later.'
    });
  }
});

// ============================================================
// API: TRANSLATE COMMENTARY
// ============================================================

app.post(
  '/api/translate-commentary',
  enforceRateLimit,
  requireGeminiMiddleware,
  enforceDailyAiLimit,
  async (req, res) => {
    try {
      const { text, commentary, items, language } = req.body || {};

      const input = text ?? commentary ?? items;

      if (!input) {
        return res.status(400).json({
          error: 'Provide text, commentary, or items to translate.'
        });
      }

      const targetLanguage = getLanguageName(language);

      const systemInstruction = `
You are a professional translator for an educational website about
the Constitution of the Republic of Uzbekistan.

Translate the supplied content into ${targetLanguage}.

Rules:
- Preserve the original meaning.
- Do not invent legal information.
- Do not change article numbers.
- Keep the translation clear and natural.
- Return only the translated content.
- If the input is an array or object, preserve its structure.
`;

      const raw = await generateGeminiText({
        systemInstruction,
        contents: JSON.stringify(input),
        maxOutputTokens: 3000
      });

      return res.json({
        translation: raw
      });

    } catch (error) {
      console.error('[TRANSLATION ERROR]', error.message);

      const status = error.status || error.code;

      if (status === 503 || status === 429) {
        return res.status(status).json({
          error: 'The AI service is temporarily unavailable. Please try again.'
        });
      }

      if (error.message?.includes('timed out')) {
        return res.status(504).json({
          error: 'Translation timed out. Please try again.'
        });
      }

      return res.status(500).json({
        error: 'Translation failed. Please try again later.'
      });
    }
  }
);

// ============================================================
// API: CHAT
// ============================================================

app.post(
  '/api/chat',
  enforceRateLimit,
  handleEmergency,
  requireGeminiMiddleware,
  enforceDailyAiLimit,
  async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 9);

    console.log(`[CHAT ${requestId}] Request received`);

    try {
      const {
        situation,
        language = 'uz_lat',
        history = []
      } = req.body || {};

      console.log(`[CHAT ${requestId}] Validating input`);

      if (
        typeof situation !== 'string' ||
        situation.trim().length < 3
      ) {
        return res.status(400).json({
          error: 'Please describe your situation.'
        });
      }

      if (situation.length > 5000) {
        return res.status(400).json({
          error: 'Your message is too long. Maximum length is 5000 characters.'
        });
      }

      const supportedLanguages = ['uz_lat', 'uz_cyr', 'ru', 'en'];

      if (!supportedLanguages.includes(language)) {
        return res.status(400).json({
          error: 'Unsupported language.'
        });
      }

      console.log(`[CHAT ${requestId}] Language: ${language}`);
      console.log(`[CHAT ${requestId}] Loaded Uzbek articles: ${uzbekArticles.length}`);

      let translatedArticles = [];

      if (language === 'ru' || language === 'en') {
        console.log(`[CHAT ${requestId}] Fetching official translation`);

        try {
          translatedArticles = await withTimeout(
            getOfficialTranslation(language),
            25000,
            'Translation request timed out.'
          );
        } catch (error) {
          console.error(
            `[CHAT ${requestId}] Translation error:`,
            error.message
          );

          return res.status(503).json({
            error: 'The requested Constitution translation is temporarily unavailable.'
          });
        }
      }

      console.log(`[CHAT ${requestId}] Retrieving articles`);

      const articles = retrieveArticles(
        situation,
        language,
        translatedArticles
      );

      const articleContext = articles.map(article => ({
        number: getArticleNumber(article),
        title: getArticleTitle(article),
        text: getArticleText(article)
      }));

      console.log(
        `[CHAT ${requestId}] Retrieved ${articleContext.length} articles:`,
        articleContext.map(article => article.number)
      );

      const responseLanguage = getLanguageName(language);

      const systemInstruction = `
You are Konstitutsiya AI, an educational assistant that explains
the Constitution of the Republic of Uzbekistan.

Always respond in ${responseLanguage}.

YOUR TASK:
Help users understand which constitutional provisions may relate
to their described situation.

IMPORTANT RULES:

1. Use the provided constitutional article context as your primary source.
2. Never invent article numbers, quotations, or legal provisions.
3. Only cite article numbers that appear in the supplied context.
4. If the context is insufficient, say so clearly.
5. Distinguish constitutional text from your general explanation.
6. Never claim that someone definitely violated the law based only
   on a short user description.
7. Do not pretend to be a lawyer or government authority.
8. Do not guarantee legal outcomes.
9. Explain concepts in accessible language.
10. Do not encourage illegal actions, retaliation, threats, or
    destruction of evidence.
11. If there is immediate danger, advise contacting emergency services
    or a trusted adult.
12. Keep answers focused and reasonably concise.
13. Do not claim to have checked articles that were not supplied.

RECOMMENDED RESPONSE STRUCTURE:

- Brief explanation of the situation.
- Potentially relevant constitutional articles.
- What those articles generally mean.
- Practical, lawful next steps.
- A short note that this is educational information, not legal advice.

If no supplied article is relevant, do not fabricate one.
`;

      console.log(`[CHAT ${requestId}] Building conversation history`);

      const contents = [];

      const safeHistory = Array.isArray(history)
        ? history.slice(-8)
        : [];

      for (const message of safeHistory) {
        if (
          !message ||
          typeof message.content !== 'string' ||
          !['user', 'assistant', 'model'].includes(message.role)
        ) {
          continue;
        }

        const role = message.role === 'user' ? 'user' : 'model';
        const content = message.content.trim().slice(0, 3000);

        if (!content) continue;

        // Avoid adding the current situation twice.
        if (
          role === 'user' &&
          content === situation.trim()
        ) {
          continue;
        }

        const previous = contents[contents.length - 1];

        if (previous && previous.role === role) {
          previous.parts[0].text += '\n' + content;
        } else {
          contents.push({
            role,
            parts: [{ text: content }]
          });
        }
      }

      const currentPrompt = `
USER'S SITUATION:
${situation.trim()}

RELEVANT CONSTITUTIONAL ARTICLES:
${JSON.stringify(articleContext, null, 2)}

Explain the situation using the supplied article context.
If the supplied context is insufficient, explicitly say so.
`;

      const lastMessage = contents[contents.length - 1];

      if (lastMessage?.role === 'user') {
        lastMessage.parts[0].text += '\n\n' + currentPrompt;
      } else {
        contents.push({
          role: 'user',
          parts: [{ text: currentPrompt }]
        });
      }

      console.log(`[CHAT ${requestId}] Sending request to Gemini`);

      const answer = await generateGeminiText({
        systemInstruction,
        contents,
        maxOutputTokens: 1400
      });

      console.log(`[CHAT ${requestId}] Gemini response received`);

      const articlesUsed = articleContext
        .filter(article => {
          if (!article.number) return false;

          const number = String(article.number).replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
          );

          const pattern = new RegExp(
            `(?:article|статья|модда)\\s*${number}\\b|\\b${number}\\s*[-–]?\\s*(?:modda|модда)`,
            'i'
          );

          return pattern.test(answer);
        })
        .map(article => ({
          number: article.number,
          title: article.title
        }));

      console.log(`[CHAT ${requestId}] Sending response`);

      return res.json({
        answer,
        articlesUsed
      });

    } catch (error) {
      console.error(
        `[CHAT ${requestId}] ERROR:`,
        error.status || error.code || '',
        error.message
      );

      if (res.headersSent) return;

      const status = error.status || error.code;

      if (error.message?.includes('timed out')) {
        return res.status(504).json({
          error: 'The AI assistant took too long to respond. Please try again.'
        });
      }

      if (status === 503 || status === 429) {
        return res.status(status).json({
          error: 'The AI service is temporarily unavailable. Please try again shortly.'
        });
      }

      return res.status(500).json({
        error: 'The AI assistant could not process your request. Please try again.'
      });
    }
  }
);

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.get(/.*/, (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, 'index.html'),
    error => {
      if (error && !res.headersSent) {
        res.status(404).send(
          'Frontend not found. Check the public directory.'
        );
      }
    }
  );
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, _req, res, _next) => {
  console.error('[SERVER ERROR]', error.message);

  if (res.headersSent) return;

  res.status(500).json({
    error: 'An unexpected server error occurred.'
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('       KONSTITUTSIYA AI SERVER');
  console.log('==========================================');
  console.log(`Website: http://localhost:${PORT}`);
  console.log(`AI: ${ai ? `Enabled (${GEMINI_MODEL})` : 'Disabled - missing GEMINI_API_KEY'}`);
  console.log(`Uzbek articles loaded: ${uzbekArticles.length}`);
  console.log('==========================================');
  console.log('');
});
