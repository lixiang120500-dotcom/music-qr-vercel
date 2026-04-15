/**
 * GET  /api/songs        → 返回所有歌曲列表
 * GET  /api/songs?id=xx  → 返回单首歌曲
 * DELETE /api/songs?id=xx → 删除歌曲
 */

const GH_TOKEN = process.env.GH_TOKEN;
const GH_OWNER = process.env.GH_OWNER || 'lixiang120500-dotcom';
const GH_REPO  = process.env.GH_REPO  || 'music-qr';
const RELEASE_TAG = 'audio-files';

async function ghFetch(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function getSongs() {
  try {
    const r = await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/songs.json`);
    const content = Buffer.from(r.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    return { songs: JSON.parse(content), sha: r.sha };
  } catch(e) {
    if (e.message.includes('404')) return { songs: {}, sha: null };
    throw e;
  }
}

async function saveSongs(songs, sha) {
  const content = Buffer.from(JSON.stringify(songs, null, 2), 'utf-8').toString('base64');
  const payload = { message: 'update songs.json', content };
  if (sha) payload.sha = sha;
  await ghFetch('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/songs.json`, payload);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!GH_TOKEN) return res.status(500).json({ error: '服务端未配置 GH_TOKEN' });

  const { id } = req.query;

  try {
    // ── GET 列表 ──────────────────────────────────────────────
    if (req.method === 'GET' && !id) {
      const { songs } = await getSongs();
      const list = Object.values(songs)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(s => ({ id: s.id, title: s.title, artist: s.artist || '', created_at: s.created_at, cover_color: s.cover_color || '#6c63ff' }));
      return res.status(200).json(list);
    }

    // ── GET 单首 ──────────────────────────────────────────────
    if (req.method === 'GET' && id) {
      const { songs } = await getSongs();
      const song = songs[id];
      if (!song) return res.status(404).json({ error: '歌曲不存在' });
      return res.status(200).json(song);
    }

    // ── DELETE ────────────────────────────────────────────────
    if (req.method === 'DELETE' && id) {
      const { songs, sha } = await getSongs();
      const song = songs[id];
      if (!song) return res.status(404).json({ error: '歌曲不存在' });

      // 删除 Release 中的音频文件
      try {
        const release = await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${RELEASE_TAG}`);
        const assets  = await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/releases/${release.id}/assets`);
        const asset   = assets.find(a => a.name === song.filename);
        if (asset) await ghFetch('DELETE', `/repos/${GH_OWNER}/${GH_REPO}/releases/assets/${asset.id}`);
      } catch(e) { /* 忽略音频删除失败 */ }

      delete songs[id];
      await saveSongs(songs, sha);
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
