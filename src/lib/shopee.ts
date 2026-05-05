// Shopee Vietnam item API fetcher.
// Given a product URL, extracts shopid + itemid and fetches the public
// item endpoint to get image URLs + video URL.
//
// Endpoint: https://shopee.vn/api/v4/item/get?itemid=X&shopid=Y
// Response shape (relevant fields):
//   { data: {
//       name, description,
//       images: [hash, hash, ...],
//       video_info_list: [{ default_format: { url, ... }, video_url_list, ... }],
//       price: int (cents-ish), price_max, ...
//     }
//   }

export interface ShopeeMedia {
  product_url: string;
  shopid: string;
  itemid: string;
  title: string;
  description: string;
  image_urls: string[];
  video_url: string | null;
  price: string | null;
}

const IMG_BASE = 'https://down-vn.img.susercontent.com/file/';
const ITEM_API = 'https://shopee.vn/api/v4/item/get';

// Examples we accept:
//   https://shopee.vn/Title-Description-i.123456.987654321
//   https://shopee.vn/product/123456/987654321
//   https://shopee.vn/opaanlp/123456/987654321  ← affiliate-tracked landing
//   https://shopee.vn/universal-link/123456/987654321
export function parseProductUrl(url: string): { shopid: string; itemid: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('shopee.vn')) return null;

    // Pattern A: /Title-Description-i.SHOPID.ITEMID
    const a = u.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (a) return { shopid: a[1]!, itemid: a[2]! };

    // Pattern B: /<segment>/SHOPID/ITEMID — covers /product/, /opaanlp/,
    // /universal-link/, etc. Two numeric path segments after one word segment.
    const b = u.pathname.match(/^\/[a-z][a-z0-9-]*\/(\d+)\/(\d+)(?:\/|$|\?)/i);
    if (b) return { shopid: b[1]!, itemid: b[2]! };

    return null;
  } catch {
    return null;
  }
}

// Resolve s.shopee.vn short link to the underlying product URL.
// Tries multiple strategies:
//   1) follow redirects automatically and read final URL
//   2) manual redirect to read Location header
//   3) scan HTML body for meta-refresh / JS redirect URL
export async function resolveShortLink(shortUrl: string): Promise<string | null> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'text/html,*/*',
  };

  // Strategy 1: follow redirects, look at final URL
  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'follow', headers });
    if (res.url && res.url !== shortUrl && /shopee\.vn/i.test(res.url) && parseProductUrl(res.url)) {
      return res.url;
    }
    // Strategy 3 (fallback): scan body for product URL or redirect target
    const text = await res.text();
    // Match common redirect patterns in HTML/JS
    const patterns = [
      /<meta\s+http-equiv=["']refresh["']\s+content=["'][^"']*url=([^"'\s]+)/i,
      /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
      /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
      /(https?:\/\/shopee\.vn\/[^\s"'<>)]+)/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1] && /shopee\.vn/i.test(m[1]) && parseProductUrl(m[1])) {
        return m[1];
      }
    }
  } catch {}

  // Strategy 2: manual redirect → Location header
  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'manual', headers });
    const loc = res.headers.get('Location');
    if (loc && /shopee\.vn/i.test(loc) && parseProductUrl(loc)) return loc;
  } catch {}

  return null;
}

export async function fetchShopeeItem(shopid: string, itemid: string): Promise<ShopeeMedia | null> {
  const url = `${ITEM_API}?itemid=${itemid}&shopid=${shopid}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Referer: `https://shopee.vn/product/${shopid}/${itemid}`,
      Accept: 'application/json',
      'X-API-SOURCE': 'pc',
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: ShopeeItemRaw } | null;
  const data = json?.data;
  if (!data) return null;

  const image_urls: string[] = (data.images ?? []).map((hash) => `${IMG_BASE}${hash}`);

  let video_url: string | null = null;
  const videoInfo = data.video_info_list?.[0];
  if (videoInfo) {
    // Prefer 720p+ if multiple formats; else use default_format
    const list = videoInfo.video_url_list ?? [];
    const sorted = [...list].sort((a, b) => (b.default_format?.height ?? 0) - (a.default_format?.height ?? 0));
    video_url = sorted[0]?.url || videoInfo.default_format?.url || null;
  }

  // Price normalization (Shopee uses int with ×100000 scaling)
  const price_raw = data.price ?? data.price_min ?? null;
  const price = price_raw ? `₫${(price_raw / 100000).toLocaleString('vi-VN')}` : null;

  return {
    product_url: `https://shopee.vn/product/${shopid}/${itemid}`,
    shopid,
    itemid,
    title: data.name ?? '',
    description: data.description ?? '',
    image_urls,
    video_url,
    price,
  };
}

// Internal Shopee response shape (best-effort typings)
interface ShopeeItemRaw {
  name?: string;
  description?: string;
  images?: string[];
  price?: number;
  price_min?: number;
  price_max?: number;
  video_info_list?: Array<{
    default_format?: { url?: string; height?: number; width?: number };
    video_url_list?: Array<{ url?: string; default_format?: { height?: number; width?: number } }>;
  }>;
}
