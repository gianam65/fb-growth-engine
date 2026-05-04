import type { Env } from '@/lib/env';

export class FbClient {
  private base: string;
  private token: string;
  private pageId: string;

  constructor(env: Env) {
    this.base = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}`;
    this.token = env.FB_PAGE_ACCESS_TOKEN;
    this.pageId = env.FB_PAGE_ID;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${this.token}`);
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`FB ${res.status} ${path}: ${text}`);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  // Reply under a comment (creates a child comment)
  // POST /{comment-id}/comments
  replyComment(commentId: string, message: string) {
    const body = new URLSearchParams({ message });
    return this.req<{ id: string }>(`/${commentId}/comments`, { method: 'POST', body });
  }

  // Send DM via Messenger Send API. recipient.comment_id pattern is used to
  // open a thread directly from a comment (Messenger Private Replies).
  sendPrivateReplyToComment(commentId: string, text: string) {
    return this.req<{ recipient_id: string; message_id: string }>(`/${this.pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    });
  }

  // Send DM to a known PSID (within 24h messaging window).
  sendDM(psid: string, text: string) {
    return this.req<{ recipient_id: string; message_id: string }>(`/${this.pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    });
  }

  // Reels upload is a 3-step flow: start session → upload bytes → finish.
  // Used by GH Action script (scripts/upload-reel.ts), kept here for reference.
  async startReelSession() {
    const body = new URLSearchParams({ upload_phase: 'start' });
    return this.req<{ video_id: string; upload_url: string }>(`/${this.pageId}/video_reels`, {
      method: 'POST',
      body,
    });
  }

  async finishReel(videoId: string, description: string) {
    const body = new URLSearchParams({
      video_id: videoId,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description,
    });
    return this.req<{ success: boolean }>(`/${this.pageId}/video_reels`, { method: 'POST', body });
  }

  // Page insights (used by daily cron).
  pageInsights(metrics: string[], since?: number, until?: number) {
    const params = new URLSearchParams({ metric: metrics.join(',') });
    if (since) params.set('since', String(since));
    if (until) params.set('until', String(until));
    return this.req<{ data: Array<{ name: string; values: Array<{ value: unknown }> }> }>(
      `/${this.pageId}/insights?${params}`,
    );
  }
}
