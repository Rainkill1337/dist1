import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
  DanmakuProviderContext,
} from '../types';
import {
  searchBangumi,
  getBangumiEpisodes,
} from '../../bilibili/bangumi';
import { getDanmaku } from '../../bilibili/danmaku';

function extractSeasonId(input: string): string | null {
  const match = input.match(/ss(\d+)/i);
  if (match) return match[1];
  const mdMatch = input.match(/md(\d+)/i);
  if (mdMatch) return mdMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

export const bilibiliBangumiDanmakuProvider: DanmakuSourceProvider = {
  name: '哔哩哔哩番剧',

  async search(
    keyword: string,
    ctx?: DanmakuProviderContext,
  ): Promise<DanmakuSearchResult[]> {
    const cookie = ctx?.cookie;
    const seasonId = extractSeasonId(keyword);

    // ss/md/seasonId：直接获取番剧信息
    if (seasonId) {
      const info = await getBangumiEpisodes(seasonId, cookie);
      if (!info || !info.seasonId) {
        return [];
      }
      return [
        {
          id: String(info.seasonId),
          title: info.title,
          cover: info.cover,
          description: info.description,
          source: 'bilibili-bangumi',
          extra: { seasonId: info.seasonId },
        },
      ];
    }

    // 普通关键词：调用番剧搜索 API
    const searchResults = await searchBangumi(keyword, cookie);
    if (searchResults.length === 0) {
      return [];
    }

    return searchResults.map((item) => ({
      id: String(item.seasonId),
      title: item.title,
      cover: item.cover,
      description: item.description,
      source: 'bilibili-bangumi',
      extra: { seasonId: item.seasonId, link: item.link },
    }));
  },

  async getEpisodes(
    identifier: string,
    ctx?: DanmakuProviderContext,
  ): Promise<DanmakuEpisode[]> {
    const cookie = ctx?.cookie;
    const seasonId = extractSeasonId(identifier);
    if (!seasonId) {
      throw new Error('无法解析 season_id');
    }

    const info = await getBangumiEpisodes(seasonId, cookie);
    if (!info || !info.episodes || info.episodes.length === 0) {
      throw new Error('该番剧暂无可用集数');
    }

    return info.episodes.map((ep, index) => ({
      id: `${ep.bvid}-${ep.cid}`,
      title: ep.title || `第 ${ep.index} 集`,
      episodeNumber: index + 1,
      playbackParams: { bvid: ep.bvid, cid: ep.cid, aid: ep.aid },
    }));
  },

  async getDanmaku(
    episode: DanmakuEpisode,
    _ctx?: DanmakuProviderContext,
  ): Promise<DanmakuItem[]> {
    const cid = episode.playbackParams.cid;
    if (typeof cid !== 'number') {
      throw new Error('缺少 cid 参数');
    }
    const items = await getDanmaku(cid);
    return items.map((item) => ({
      id: item.id,
      content: item.content,
      time: item.time,
      mode: item.mode,
      color: item.color,
      size: item.size,
    }));
  },
};
