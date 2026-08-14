import { bilibiliFetch } from './client';
import { getWbiKeys, signParams } from './wbi';

export interface BangumiEpisode {
  bvid: string;
  cid: number;
  title: string;
  index: string | number;
  aid?: number;
}

export interface BangumiSeasonInfo {
  seasonId: number;
  title: string;
  cover?: string;
  description?: string;
  link?: string;
  episodes: BangumiEpisode[];
}

interface BangumiSeasonResult {
  season_id?: number;
  title?: string;
  cover?: string;
  episodes?: unknown[];
  main_section?: { episodes?: unknown[] };
  section?: { episodes?: unknown[] }[];
}

/** 将参数对象转为 URL 查询字符串（已编码）。 */
function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
}

function normalizeImageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

export async function getBangumiEpisodes(
  seasonId: string,
  cookie?: string,
): Promise<BangumiSeasonInfo> {
  const data = await bilibiliFetch<{ result?: BangumiSeasonResult }>(
    `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId.trim()}`,
    { cookie },
  );

  const result =
    (data as unknown as { result?: BangumiSeasonResult }).result ??
    data.data?.result;

  if (!result) {
    throw new Error('获取番剧信息失败');
  }

  let rawEpisodes: unknown[] = [];
  if (result.episodes && result.episodes.length > 0) {
    rawEpisodes = result.episodes;
  } else if (result.main_section?.episodes && result.main_section.episodes.length > 0) {
    rawEpisodes = result.main_section.episodes;
  } else if (Array.isArray(result.section)) {
    rawEpisodes = result.section.flatMap((s) => s.episodes || []);
  }

  const episodes = rawEpisodes.map((ep: unknown, idx: number) => {
    const item = ep as {
      bvid?: string;
      cid?: number;
      aid?: number;
      title_format?: string;
      long_title?: string;
      title?: string;
      index?: string | number;
    };
    return {
      bvid: item.bvid || '',
      cid: item.cid || 0,
      aid: item.aid,
      title:
        [item.title_format, item.long_title].filter(Boolean).join(' ') ||
        item.long_title ||
        item.title ||
        '',
      index: item.title || item.index || idx + 1,
    };
  });

  return {
    seasonId: Number(result.season_id) || 0,
    title: result.title || '',
    cover: normalizeImageUrl(result.cover || ''),
    episodes,
  };
}

/**
 * 使用 WBI 签名调用 /x/web-interface/wbi/search/type 按关键词搜索番剧。
 *
 * 注意：B站 搜索接口（包括 media_bangumi 类型）现已强制要求 WBI 签名，
 * 未签名请求会返回 HTML 错误页面（带 <!DOCTYPE）而非 JSON，
 * 导致前端 JSON.parse 抛出 "Unexpected token '<'" 错误。
 * 因此必须使用 wbi/search/type 端点 + signParams 签名，与 searchVideos 保持一致。
 *
 * 返回最多 10 条结果，每条包含 seasonId、标题、封面、描述。
 * episodes 字段为空数组，需后续调用 getBangumiEpisodes(seasonId) 获取分集列表。
 */
export async function searchBangumi(
  keyword: string,
  cookie?: string,
): Promise<BangumiSeasonInfo[]> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    {
      keyword,
      search_type: 'media_bangumi',
      page: '1',
      page_size: '20',
    },
    imgKey,
    subKey,
  );
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<{
    result?: unknown[];
    numResults?: number;
  }>(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,
    { cookie },
  );

  // B站搜索 API 返回的数据结构：data.result 是数组（不是 data.result.result）
  const list = res.data?.result;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.slice(0, 10).map((item: unknown) => {
    const raw = item as {
      season_id?: number | string;
      title?: string;
      cover?: string;
      description?: string;
      media_id?: number | string;
      link?: string;
    };
    const seasonId =
      Number(raw.season_id) ||
      Number(raw.media_id) ||
      0;
    return {
      seasonId,
      title: (raw.title || '').replace(/<[^>]+>/g, ''),
      cover: normalizeImageUrl(raw.cover || ''),
      episodes: [],
      description: raw.description,
      link: raw.link,
    };
  }) as BangumiSeasonInfo[];
}
