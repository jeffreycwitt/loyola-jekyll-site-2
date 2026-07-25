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

const CMS_URL   = process.env.CMS_URL      ?? 'http://localhost:3000';
const CMS_EMAIL = process.env.CMS_EMAIL    ?? null;
const CMS_PASS  = process.env.CMS_PASSWORD ?? null;
const POSTS_DIR = '_posts';

rmSync(POSTS_DIR, { recursive: true, force: true });
mkdirSync(POSTS_DIR, { recursive: true });

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
      const { url, alt, width, height } = node.value ?? {};
      if (!url) return '';
      const src  = url.startsWith('http') ? url : `${CMS_URL}${url}`;
      const dims = width && height ? ` width="${width}" height="${height}"` : '';
      return `<img src="${src}" alt="${alt ?? ''}"${dims}>`;
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
    const url = `${CMS_URL}/api/posts?page=${page}&limit=100`;
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
  const frontMatter = [
    '---',
    `layout: post`,
    `title: "${title}"`,
    `date: ${date}`,
    `cms_id: ${post.id}`,
    authorEmail ? `author: "${authorEmail}"` : null,
    '---',
  ].filter(Boolean).join('\n');

  const body = lexicalToHtml(post.content?.root ?? { type: 'root', children: [] }, slugMap);

  return { filename, content: `${frontMatter}\n\n${body}\n` };
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

  console.log(`Fetching posts from ${CMS_URL}...`);
  const [posts, userMap] = await Promise.all([
    fetchAllPosts(token),
    fetchUserMap(token),
  ]);
  console.log(`Fetched ${posts.length} post(s), ${userMap.size} user(s).`);

  const slugMap = new Map(posts.map(p => [
    p.id,
    { date: formatDate(p.publishedDate ?? p.createdAt), slug: slugify(p.title) },
  ]));

  for (const post of posts) {
    const { filename, content } = buildPostFile(post, slugMap, userMap);
    const filepath = join(POSTS_DIR, filename);
    writeFileSync(filepath, content, 'utf8');
    console.log(`  wrote ${filepath}`);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
