#!/usr/bin/env node

import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Load .env if present; existing env vars (CI secrets, shell exports) take precedence
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const CMS_URL       = process.env.CMS_URL       ?? 'http://localhost:3000';
const CMS_EMAIL     = process.env.CMS_EMAIL     ?? null;
const CMS_PASS      = process.env.CMS_PASSWORD  ?? null;
const CMS_GROUP     = process.env.CMS_GROUP     || null;
const CMS_PORTFOLIO = process.env.CMS_PORTFOLIO || null;
const POSTS_DIR = '_posts';

rmSync(POSTS_DIR, { recursive: true, force: true });
mkdirSync(POSTS_DIR, { recursive: true });
mkdirSync('_data', { recursive: true });
rmSync('_data/portfolio.yml',  { force: true });
rmSync('_data/portfolios.yml', { force: true });

// --- Auth ---

async function login(email, password) {
  const res = await fetch(`${CMS_URL}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.token) throw new Error(`Login failed: ${JSON.stringify(data.errors ?? data)}`);
  return data.token;
}

function authHeaders(token) {
  return token ? { Authorization: `JWT ${token}` } : {};
}

// --- Utilities ---

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function formatDate(dateStr) {
  return new Date(dateStr).toISOString().slice(0, 10);
}

function youtubeEmbedUrl(url) {
  const short = url.match(/youtu\.be\/([^?]+)/);
  if (short) return `https://www.youtube.com/embed/${short[1]}`;
  const long  = url.match(/[?&]v=([^&]+)/);
  if (long)  return `https://www.youtube.com/embed/${long[1]}`;
  return null;
}

// --- Lexical → HTML ---

function applyTextFormat(text, format) {
  let out = text;
  if (format & 1)  out = `<strong>${out}</strong>`;
  if (format & 2)  out = `<em>${out}</em>`;
  if (format & 4)  out = `<s>${out}</s>`;
  if (format & 8)  out = `<u>${out}</u>`;
  if (format & 16) out = `<code>${out}</code>`;
  return out;
}

// slugMap: Map<cms_id, { date, slug }> for resolving internal doc links
function lexicalToHtml(node, slugMap = new Map()) {
  if (!node) return '';
  const children = () => (node.children ?? []).map(n => lexicalToHtml(n, slugMap)).join('');

  switch (node.type) {
    case 'root':
      return (node.children ?? []).map(n => lexicalToHtml(n, slugMap)).join('\n');

    case 'paragraph':
      return `<p>${children()}</p>`;

    case 'heading':
      return `<${node.tag}>${children()}</${node.tag}>`;

    case 'text':
      return applyTextFormat(node.text ?? '', node.format ?? 0);

    case 'list': {
      const tag = node.listType === 'number' ? 'ol' : 'ul';
      return `<${tag}>${children()}</${tag}>`;
    }

    case 'listitem':
      return `<li>${children()}</li>`;

    case 'link': {
      let href = '#';
      if (node.fields?.url) {
        href = node.fields.url;
      } else if (node.fields?.doc?.value) {
        const linked = node.fields.doc.value;
        const entry  = slugMap.get(linked.id);
        href = entry ? `/${entry.date.replace(/-/g, '/')}/${entry.slug}/` : '#';
      } else if (node.url) {
        href = node.url;
      }
      return `<a href="${href}">${children()}</a>`;
    }

    case 'upload': {
      const { url, alt, width, height, mimeType } = node.value ?? {};
      if (!url) return '';
      const src  = url.startsWith('http') ? url : `${CMS_URL}${url}`;
      const isAudio = mimeType?.startsWith('audio/') || /\.(m4a|mp3|wav|ogg|aac|flac)$/i.test(url);
      const isVideo = mimeType?.startsWith('video/') || /\.(mp4|webm|ogv|mov)$/i.test(url);
      if (isAudio) {
        const type = mimeType ?? (/\.m4a$/i.test(url) ? 'audio/mp4' : 'audio/mpeg');
        return `<audio controls><source src="${src}" type="${type}"></audio>`;
      }
      if (isVideo) {
        const type = mimeType ?? 'video/mp4';
        return `<video controls><source src="${src}" type="${type}"></video>`;
      }
      const safeAlt = (alt ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const dims = width && height ? ` width="${width}" height="${height}"` : '';
      return `<img src="${src}" alt="${safeAlt}"${dims}>`;
    }

    case 'block': {
      const { blockType, url } = node.fields ?? {};
      if (blockType === 'video' && url) {
        const embedUrl = youtubeEmbedUrl(url);
        if (embedUrl) {
          return `<div class="video-embed"><iframe src="${embedUrl}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
        }
        return `<p><a href="${url}">${url}</a></p>`;
      }
      return '';
    }

    default:
      if (node.children) return children();
      return '';
  }
}

// --- YAML helpers ---

function yamlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function writePortfolioYaml(portfolio) {
  const lines = [
    `id: ${portfolio.id}`,
    `title: ${yamlStr(portfolio.title)}`,
  ];
  if (portfolio.description) lines.push(`description: ${yamlStr(portfolio.description)}`);
  lines.push('items:');
  for (const id of portfolio.items) lines.push(`  - ${id}`);
  writeFileSync('_data/portfolio.yml', lines.join('\n') + '\n', 'utf8');
}

function writePortfoliosYaml(portfolios) {
  const lines = [];
  for (const p of portfolios) {
    lines.push(`- id: ${p.id}`);
    lines.push(`  title: ${yamlStr(p.title)}`);
    lines.push(`  slug: ${yamlStr(p.slug)}`);
    if (p.description) lines.push(`  description: ${yamlStr(p.description)}`);
    lines.push(`  items: [${p.items.join(', ')}]`);
  }
  writeFileSync('_data/portfolios.yml', lines.join('\n') + '\n', 'utf8');
}

// --- Fetch ---

async function fetchUserMap(token) {
  const res = await fetch(`${CMS_URL}/api/users?limit=100`, { headers: authHeaders(token) });
  if (!res.ok) return new Map();
  const data = await res.json();
  if (data.errors) return new Map();
  return new Map(data.docs.map(u => [u.id, u.email]));
}

async function fetchAllPosts(token) {
  const posts = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    const statusFilter = `&where[_status][equals]=published`;
    const groupFilter = CMS_GROUP
      ? `&where[group.name][equals]=${encodeURIComponent(CMS_GROUP)}`
      : '';
    const url = `${CMS_URL}/api/posts?page=${page}&limit=100${statusFilter}${groupFilter}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`Failed to fetch posts (page ${page}): ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.errors) throw new Error(`API error: ${JSON.stringify(data.errors)}`);
    posts.push(...data.docs);
    hasNextPage = data.hasNextPage;
    page++;
  }

  return posts;
}

async function fetchPortfolios(token, group) {
  const groupFilter = group
    ? `&where[group.name][equals]=${encodeURIComponent(group)}`
    : '';
  const res = await fetch(
    `${CMS_URL}/api/portfolios?limit=100&depth=2${groupFilter}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Failed to fetch portfolios: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.docs ?? [];
}

async function fetchPortfolioById(token, idOrTitle) {
  if (/^\d+$/.test(idOrTitle)) {
    const res = await fetch(
      `${CMS_URL}/api/portfolios/${idOrTitle}?depth=2`,
      { headers: authHeaders(token) },
    );
    if (res.ok) return res.json();
  }
  const res = await fetch(
    `${CMS_URL}/api/portfolios?limit=1&depth=2&where[title][equals]=${encodeURIComponent(idOrTitle)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Failed to find portfolio "${idOrTitle}": ${res.status}`);
  const data = await res.json();
  if (!data.docs?.length) throw new Error(`Portfolio not found: "${idOrTitle}"`);
  return data.docs[0];
}

// --- File generation ---

function buildPostFile(post, slugMap, userMap) {
  const date  = formatDate(post.publishedDate ?? post.createdAt);
  const slug  = slugify(post.title);
  const filename = `${date}-${slug}.html`;

  const authorId = post.author != null
    ? (typeof post.author === 'object' ? post.author.id : post.author)
    : null;
  const authorEmail = authorId != null ? (userMap.get(authorId) ?? null) : null;

  const title = post.title.replace(/"/g, '\\"');
  const tags = (post.tags ?? []).map(t => t.tag).filter(Boolean);
  const frontMatter = [
    '---',
    `layout: post`,
    `title: "${title}"`,
    `date: ${date}`,
    `cms_id: ${post.id}`,
    authorEmail ? `author: "${authorEmail}"` : null,
    tags.length ? `tags: [${tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]` : null,
    '---',
  ].filter(Boolean).join('\n');

  const body = lexicalToHtml(post.content?.root ?? { type: 'root', children: [] }, slugMap);

  return { filename, content: `${frontMatter}\n\n${body}\n` };
}

// --- Helpers ---

function postsFromPortfolio(portfolio) {
  return (portfolio.items ?? [])
    .map(item => (item.post && typeof item.post === 'object' ? item.post : null))
    .filter(Boolean);
}

function writePosts(posts, slugMap, userMap) {
  for (const post of posts) {
    const { filename, content } = buildPostFile(post, slugMap, userMap);
    const filepath = join(POSTS_DIR, filename);
    writeFileSync(filepath, content, 'utf8');
    console.log(`  wrote ${filepath}`);
  }
}

// --- Main ---

async function main() {
  let token = null;

  if (CMS_EMAIL && CMS_PASS) {
    console.log(`Logging in as ${CMS_EMAIL}...`);
    token = await login(CMS_EMAIL, CMS_PASS);
    console.log('Login successful.');
  } else {
    console.log('No credentials provided — fetching as public user.');
  }

  const userMap = await fetchUserMap(token);

  if (CMS_PORTFOLIO === 'all') {
    // Multi-portfolio mode: aggregate all portfolios filtered by group
    if (CMS_GROUP) console.log(`Filtering portfolios to group: ${CMS_GROUP}`);
    console.log('Multi-portfolio mode: fetching portfolios...');
    const rawPortfolios = await fetchPortfolios(token, CMS_GROUP);
    console.log(`Fetched ${rawPortfolios.length} portfolio(s).`);

    const portfolioData = [];
    const postMap = new Map(); // cms_id → post (deduplicates)

    for (const portfolio of rawPortfolios) {
      const items = postsFromPortfolio(portfolio);
      const cmsIds = [];
      for (const post of items) {
        if (!postMap.has(post.id)) postMap.set(post.id, post);
        cmsIds.push(post.id);
      }
      portfolioData.push({
        id: portfolio.id,
        title: portfolio.title ?? '',
        description: portfolio.description ?? '',
        slug: slugify(portfolio.title ?? String(portfolio.id)),
        items: cmsIds,
      });
    }

    const posts = [...postMap.values()];
    console.log(`Total unique posts across portfolios: ${posts.length}`);

    const slugMap = new Map(posts.map(p => [
      p.id,
      { date: formatDate(p.publishedDate ?? p.createdAt), slug: slugify(p.title) },
    ]));

    writePosts(posts, slugMap, userMap);
    writePortfoliosYaml(portfolioData);
    console.log(`  wrote _data/portfolios.yml (${portfolioData.length} portfolio(s))`);

  } else if (CMS_PORTFOLIO) {
    // Single-portfolio mode
    console.log(`Single-portfolio mode: fetching portfolio "${CMS_PORTFOLIO}"...`);
    const portfolio = await fetchPortfolioById(token, CMS_PORTFOLIO);
    console.log(`Found portfolio: "${portfolio.title}"`);

    const allItems = postsFromPortfolio(portfolio);
    const cmsIds = allItems.map(p => p.id); // keep ordering (including any duplicates)

    // Deduplicate posts for _posts/
    const seen = new Set();
    const posts = allItems.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    const slugMap = new Map(posts.map(p => [
      p.id,
      { date: formatDate(p.publishedDate ?? p.createdAt), slug: slugify(p.title) },
    ]));

    writePosts(posts, slugMap, userMap);
    writePortfolioYaml({
      id: portfolio.id,
      title: portfolio.title ?? '',
      description: portfolio.description ?? '',
      items: cmsIds,
    });
    console.log('  wrote _data/portfolio.yml');

  } else {
    // Regular mode: date-sorted posts filtered by group/status
    if (CMS_GROUP) console.log(`Filtering to group: ${CMS_GROUP}`);
    console.log(`Fetching posts from ${CMS_URL}...`);
    const posts = await fetchAllPosts(token);
    console.log(`Fetched ${posts.length} post(s).`);

    const slugMap = new Map(posts.map(p => [
      p.id,
      { date: formatDate(p.publishedDate ?? p.createdAt), slug: slugify(p.title) },
    ]));

    writePosts(posts, slugMap, userMap);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
