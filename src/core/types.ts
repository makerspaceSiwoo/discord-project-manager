export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  PROJECT_ID: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CLIENT_SECRET: string;
  NOTION_TOKEN: string;
  NOTION_VERSION: string;
  NOTION_WEBHOOK_SECRET: string;
  WEBHOOK_SETUP_KEY?: string;
}
export interface Project {
  id: string;
  name: string;
  timezone: string;
  guildId: string;
  memberRoleId: string;
  adminRoleIds: string[];
  adminUserIds?: string[];
  features?: { issues?: boolean; automation?: boolean };
  linkingEnabled?: boolean;
  schedulingChannelId: string;
  reportChannelId: string;
  issueChannelId: string;
  issueChannelMode: 'forum' | 'text';
  notion: {
    workspaceId: string;
    databaseId: string;
    dataSourceId: string;
    verificationPageId: string;
    probePageId: string;
    guestVerificationEnabled: boolean;
    guestEvidence: string;
    properties: Record<
      | 'taskId'
      | 'title'
      | 'due'
      | 'assignees'
      | 'type'
      | 'priority'
      | 'status'
      | 'created'
      | 'parent'
      | 'children'
      | 'discord',
      string
    >;
    statusType: 'status' | 'select';
    initialStatus: string;
    excludedStatuses: string[];
    types: string[];
    priorities: string[];
  };
  schedule: { open: string; reminder: string; report: string };
  enabled: boolean;
  maxMembers: number;
  /** 0 keeps verified account links until explicitly revoked. */
  linkLifetimeDays: number;
}
export interface Identity {
  userId: string;
  name: string;
  sessionHash: string;
  sessionCookie?: string;
  csrf: string;
  admin: boolean;
}
export interface Issue {
  id: string;
  taskId: string;
  title: string;
  due: string | null;
  assignees: string[];
  type: string;
  priority: string;
  status: string;
  statusColor?: string;
  created: string;
  parentIds: string[];
  archived: boolean;
  url: string;
  description: string;
  edited: string;
}
export interface Draft {
  title: string;
  due: string;
  assignee: string;
  type: string;
  priority: string;
  description: string;
}
export interface Job {
  id: string;
  kind: string;
  payload: string;
  state: string;
  attempts: number;
  lease: string;
}
export interface Member {
  id: string;
  name: string;
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid',
  ) {
    super(message);
  }
}
export class RemoteError extends Error {
  constructor(
    public service: string,
    public status: number,
    public retryAfter: number,
    public ambiguous = false,
  ) {
    super(`${service}:${status}`);
  }
}
export const now = () => Date.now();
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
