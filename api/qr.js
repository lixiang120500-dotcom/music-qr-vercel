/**
 * GET /api/qr?url=<encoded_url>&size=240
 * 服务端生成 QR 码 PNG，返回给前端
 * 不依赖任何浏览器端 CDN
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, size = '240' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const sz = Math.min(Math.max(parseInt(size) || 240, 100), 600);

  try {
    // 动态 import qrcode（Vercel Node.js 运行时自带）
    const QRCode = (await import('qrcode')).default;

    // 生成 QR 码 PNG Buffer
    const buf = await QRCode.toBuffer(url, {
      width: sz,
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 缓存 1 天
    res.status(200).send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
