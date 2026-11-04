import { Notion } from '../adapters/notion';
import { one } from './db';
import { effect } from './effects';
import { AppError, RemoteError, type Draft, type Project } from './types';

export const NOTION_CREATE_UNCERTAIN = 'notion_create_uncertain';
const uncertain = () =>
  new AppError(
    409,
    'Notion 이슈 생성 여부를 확인하지 못했습니다. 자동 재생성을 중단했습니다. Notion에서 생성 여부를 확인한 뒤 관리자에게 알려주세요. 새로 요청하면 중복될 수 있습니다.',
    NOTION_CREATE_UNCERTAIN,
  );

// D1 job/effect IDs remain internal; no request marker is stored in Notion.
export async function createIssuePage(
  db: D1Database,
  notion: Notion,
  project: Project,
  draft: Draft,
  notionUserId: string,
  jobId: string,
) {
  try {
    return await effect<any>(
      db,
      jobId + ':notion',
      async () => {
        const page = await notion.create(project, draft, notionUserId);
        if (typeof page?.id !== 'string' || !page.id) throw uncertain();
        return page;
      },
      async () => {
        // Can recover an already recorded page ID, but never search by title or guess a match.
        const link = await one(
          db,
          'SELECT page_id FROM issue_links WHERE request_id=? AND project_id=?',
          jobId,
          project.id,
        );
        if (link) return { id: link.page_id };
        throw uncertain();
      },
    );
  } catch (error) {
    // Explicit rejection (including 429) can be retried safely after fixing/waiting.
    if (
      error instanceof RemoteError &&
      !error.ambiguous &&
      error.status >= 400 &&
      error.status < 500
    )
      throw error;
    // Includes timeout, 5xx, unreadable success response and failure to persist a success.
    throw uncertain();
  }
}
