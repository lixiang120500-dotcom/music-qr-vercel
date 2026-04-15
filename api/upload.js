/**
 * POST /api/upload
 * 接收音频文件 + 歌曲元数据，上传到 GitHub Release，更新 songs.json
 * Token 存在 Vercel 环境变量 GH_TOKEN 里，前端完全不接触
 */

export const config = { api: { bodyParser: false } };

const GH_TOKEN = process.env.GH_TOKEN;
const GH_OWNER = process.env.GH_OWNER || 'lixiang120500-dotcom';
const GH_REPO  = process.env.GH_REPO  || 'music-qr';
const RELEASE_TAG = 'audio-files';

// ── 工具：GitHub API 请求 ─────────────────────────────────────
async function ghFetch(method, path, body, opts = {}) {
  const base = opts.upload ? 'https://uploads.github.com' : 'https://api.github.com';
  const res = await fetch(base + path, {
    method,
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': opts.contentType || 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── 工具：读取 multipart/form-data ───────────────────────────
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct  = req.headers['content-type'] || '';
      const boundary = ct.split('boundary=')[1];
      if (!boundary) return reject(new Error('no boundary'));

      const parts = {};
      const sep   = Buffer.from(`--${boundary}`);
      let pos = 0;

      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        pos = start + sep.length;
        if (buf[pos] === 45 && buf[pos+1] === 45) break; // --

        // 跳过 \r\n
        if (buf[pos] === 13) pos += 2;

        // 读取 headers
        const headerEnd = buf.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) break;
        const headerStr = buf.slice(pos, headerEnd).toString();
        pos = headerEnd + 4;

        // 找下一个 boundary
        const nextBound = buf.indexOf(sep, pos);
        const dataEnd   = nextBound === -1 ? buf.length : nextBound - 2; // -2 for \r\n
        const data      = buf.slice(pos, dataEnd);
        pos = nextBound === -1 ? buf.length : nextBound;

        // 解析 Content-Disposition
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const fileMatch = headerStr.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        if (fileMatch) {
          const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
          parts[name] = {
            filename: fileMatch[1],
            contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            data,
          };
        } else {
          parts[name] = data.toString();
        }
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

// ── 获取或创建 Release ────────────────────────────────────────
async function getOrCreateRelease() {
  try {
    return await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${RELEASE_TAG}`);
  } catch(e) {
    if (e.message.includes('404')) {
      return await ghFetch('POST', `/repos/${GH_OWNER}/${GH_REPO}/releases`, JSON.stringify({
        tag_name: RELEASE_TAG, name: 'Audio Files',
        body: '音频文件（由 music-qr-tool 自动管理）',
        draft: false, prerelease: false,
      }));
    }
    throw e;
  }
}

// ── 读写 songs.json（main 分支）────────────────────────────────
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
  await ghFetch('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/songs.json`, JSON.stringify(payload));
}

// ── 同步写 gh-pages 分支的 songs.json（播放器直接读，不经过 Vercel）──
async function syncGhPagesSongs(songs) {
  try {
    // 只保留播放器需要的字段，减小文件体积
    const content = Buffer.from(JSON.stringify(songs, null, 2), 'utf-8').toString('base64');
    // 先获取 gh-pages 分支上的 sha
    let sha = null;
    try {
      const r = await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/songs.json?ref=gh-pages`);
      sha = r.sha;
    } catch(e) { /* 文件不存在则新建 */ }
    const payload = { message: 'sync songs.json', content, branch: 'gh-pages' };
    if (sha) payload.sha = sha;
    await ghFetch('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/songs.json`, JSON.stringify(payload));
  } catch(e) {
    console.error('syncGhPagesSongs failed:', e.message); // 非致命，不影响主流程
  }
}

// ── 主处理函数 ────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!GH_TOKEN) return res.status(500).json({ error: '服务端未配置 GH_TOKEN 环境变量' });

  try {
    const parts = await parseMultipart(req);

    const title      = (parts.title      || '').trim();
    const artist     = (parts.artist     || '').trim();
    const lyrics     = (parts.lyrics     || '').trim();
    const coverColor = (parts.cover_color || '#6c63ff').trim();
    const audioFile  = parts.audio;

    if (!title)     return res.status(400).json({ error: '歌名不能为空' });
    if (!audioFile) return res.status(400).json({ error: '请上传音频文件' });

    const allowed = ['mp3','m4a','ogg','wav','flac','aac'];
    const ext = audioFile.filename.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) return res.status(400).json({ error: `不支持的格式：${ext}` });

    const songId   = Math.random().toString(36).slice(2, 10);
    const filename = `${songId}.${ext}`;

    // 1. 上传音频到 GitHub Release（服务端调用，无 CORS 限制）
    const release  = await getOrCreateRelease();

    // 删除同名旧文件
    try {
      const assets = await ghFetch('GET', `/repos/${GH_OWNER}/${GH_REPO}/releases/${release.id}/assets`);
      for (const a of assets) {
        if (a.name === filename) {
          await ghFetch('DELETE', `/repos/${GH_OWNER}/${GH_REPO}/releases/assets/${a.id}`);
          break;
        }
      }
    } catch(e) { /* 忽略 */ }

    const uploadResp = await ghFetch(
      'POST',
      `/repos/${GH_OWNER}/${GH_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`,
      audioFile.data,
      { upload: true, contentType: audioFile.contentType }
    );
    const audioUrl = uploadResp.browser_download_url;

    // 2. 更新 songs.json（main 分支）
    const { songs, sha } = await getSongs();
    songs[songId] = {
      id: songId, title, artist, lyrics,
      cover_color: coverColor,
      audio_url: audioUrl, filename,
      created_at: new Date().toISOString(),
    };
    await saveSongs(songs, sha);

    // 3. 同步到 gh-pages 分支（播放器直接读，不经过 Vercel API）
    await syncGhPagesSongs(songs);

    res.status(200).json({ song_id: songId, title });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
