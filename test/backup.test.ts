import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { resetDatabase } from "./reset-db";
import { handleQueueMessage } from "../src/backup";
import { insertNewEpisodes, getEpisodes } from "../src/db";
import type { NewEpisode } from "../src/db";

function makeNewEpisode(overrides: Partial<NewEpisode> = {}): NewEpisode {
  return {
    uuid: "ep-1",
    url: "https://example.com/ep1.mp3",
    title: "Test Episode",
    podcast_title: "Test Podcast",
    podcast_uuid: "pod-1",
    published: "2024-01-15T10:00:00Z",
    duration: 3600,
    file_type: "audio/mpeg",
    size: "50000000",
    playing_status: 3,
    played_up_to: 3600,
    is_deleted: 0,
    starred: 0,
    episode_type: "full",
    episode_season: 1,
    episode_number: 1,
    author: "Test Author",
    slug: "test-episode",
    podcast_slug: "test-podcast",
    ...overrides,
  };
}

function stubApi(syncEpisodes: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const href = String(url);

    if (href.includes("/user/podcast/episodes")) {
      return { ok: true, json: async () => ({ episodes: syncEpisodes }) } as unknown as Response;
    }

    if (href.includes("cache.pocketcasts.com")) {
      return {
        ok: true,
        json: async () => ({
          episode_count: 42,
          has_more_episodes: false,
          podcast: { episodes: [] },
        }),
      } as unknown as Response;
    }

    throw new Error(`Unexpected fetch: ${href}`);
  }));
}

function syncItem(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "ep-1",
    playingStatus: 3,
    playedUpTo: 3600,
    isDeleted: false,
    starred: false,
    duration: 3600,
    bookmarks: [],
    deselectedChapters: "",
    ...overrides,
  };
}

const syncPodcastMessage = {
  type: "sync-podcast" as const,
  token: "test-token",
  podcastUuid: "pod-1",
  podcastTitle: "Test Podcast",
  podcastAuthor: "Test Author",
  podcastSlug: "test-podcast",
};

beforeEach(async () => {
  await resetDatabase();
  // syncPodcast bumps the progress row, and leaves history alone while completed < total
  await env.DB.exec("INSERT INTO backup_progress (id, total, completed) VALUES (1, 10, 0)");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncPodcast", () => {
  it("does not write episodes whose sync data has not changed", async () => {
    await insertNewEpisodes(env.DB, [makeNewEpisode({ playing_status: 3, played_up_to: 3600 })]);

    stubApi([syncItem({ playingStatus: 3, playedUpTo: 3600 })]);
    const batch = vi.spyOn(env.DB, "batch");

    await handleQueueMessage(syncPodcastMessage, env);

    expect(batch).not.toHaveBeenCalled();
  });

  it("writes episodes whose sync data has changed", async () => {
    await insertNewEpisodes(env.DB, [makeNewEpisode({ playing_status: 2, played_up_to: 1800 })]);

    stubApi([syncItem({ playingStatus: 3, playedUpTo: 3600, starred: true })]);
    const batch = vi.spyOn(env.DB, "batch");

    await handleQueueMessage(syncPodcastMessage, env);

    expect(batch).toHaveBeenCalledTimes(1);

    const episodes = await getEpisodes(env.DB);
    expect(episodes[0].playing_status).toBe(3);
    expect(episodes[0].played_up_to).toBe(3600);
    expect(episodes[0].starred).toBe(1);
  });

  it("only writes the episodes that changed", async () => {
    await insertNewEpisodes(env.DB, [
      makeNewEpisode({ uuid: "ep-1", playing_status: 3, played_up_to: 3600 }),
      makeNewEpisode({ uuid: "ep-2", playing_status: 3, played_up_to: 3600 }),
    ]);

    stubApi([
      syncItem({ uuid: "ep-1", playingStatus: 3, playedUpTo: 3600 }),
      syncItem({ uuid: "ep-2", playingStatus: 3, playedUpTo: 1200 }),
    ]);

    const batch = vi.spyOn(env.DB, "batch");

    await handleQueueMessage(syncPodcastMessage, env);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(1);

    const episodes = await getEpisodes(env.DB);
    expect(episodes.find(e => e.uuid === "ep-1")!.played_up_to).toBe(3600);
    expect(episodes.find(e => e.uuid === "ep-2")!.played_up_to).toBe(1200);
  });
});
