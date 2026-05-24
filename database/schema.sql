CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    banned BOOLEAN NOT NULL DEFAULT false,
    banned_until TIMESTAMPTZ,
    ban_reason TEXT,
    discord_id TEXT UNIQUE,
    discord_username TEXT NOT NULL DEFAULT '',
    discord_avatar TEXT,
    discord_role_name TEXT NOT NULL DEFAULT '',
    discord_role_color INTEGER NOT NULL DEFAULT 0,
    account_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    username_lower TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    matchmaking_id TEXT NOT NULL UNIQUE,
    is_server BOOLEAN NOT NULL DEFAULT false,
    current_sac_code TEXT,
    last_username_change TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_banned_idx ON users (banned);
CREATE INDEX IF NOT EXISTS users_is_server_idx ON users (is_server);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id TEXT NOT NULL UNIQUE,
    profiles JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS profiles_profiles_gin_idx ON profiles USING GIN (profiles);

CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id TEXT NOT NULL UNIQUE,
    list JSONB NOT NULL DEFAULT '{"accepted":[],"incoming":[],"outgoing":[],"blocked":[]}'::jsonb
);

CREATE INDEX IF NOT EXISTS friends_list_gin_idx ON friends USING GIN (list);

CREATE TABLE IF NOT EXISTS arena (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    hype INTEGER NOT NULL DEFAULT 0,
    division INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS arena_hype_idx ON arena (hype DESC);

CREATE TABLE IF NOT EXISTS userstats (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id TEXT NOT NULL UNIQUE,
    solo JSONB NOT NULL DEFAULT '{}'::jsonb,
    duo JSONB NOT NULL DEFAULT '{}'::jsonb,
    trio JSONB NOT NULL DEFAULT '{}'::jsonb,
    squad JSONB NOT NULL DEFAULT '{}'::jsonb,
    ltm JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS userstats_solo_gin_idx ON userstats USING GIN (solo);
CREATE INDEX IF NOT EXISTS userstats_duo_gin_idx ON userstats USING GIN (duo);
CREATE INDEX IF NOT EXISTS userstats_trio_gin_idx ON userstats USING GIN (trio);
CREATE INDEX IF NOT EXISTS userstats_squad_gin_idx ON userstats USING GIN (squad);
CREATE INDEX IF NOT EXISTS userstats_ltm_gin_idx ON userstats USING GIN (ltm);

CREATE TABLE IF NOT EXISTS sac_codes (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    createdby TEXT NOT NULL,
    owneraccount_id TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    code_lower TEXT NOT NULL UNIQUE,
    code_higher TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mmcodes (
    id TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    code TEXT NOT NULL,
    code_lower TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_tickets (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    account_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS launch_tickets_account_id_idx ON launch_tickets (account_id);
CREATE INDEX IF NOT EXISTS launch_tickets_expires_at_idx ON launch_tickets (expires_at);

CREATE TABLE IF NOT EXISTS fingerprints (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    fingerprint_hash TEXT NOT NULL,
    hwid JSONB NOT NULL DEFAULT '{}'::jsonb,
    network JSONB NOT NULL DEFAULT '{}'::jsonb,
    scores JSONB NOT NULL DEFAULT '{}'::jsonb,
    flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    history JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fingerprints_account_last_seen_idx ON fingerprints (account_id, ((history #>> '{lastSeen}')) DESC);
CREATE INDEX IF NOT EXISTS fingerprints_hash_account_idx ON fingerprints (fingerprint_hash, account_id);
CREATE INDEX IF NOT EXISTS fingerprints_hwid_gin_idx ON fingerprints USING GIN (hwid);
CREATE INDEX IF NOT EXISTS fingerprints_network_gin_idx ON fingerprints USING GIN (network);
CREATE INDEX IF NOT EXISTS fingerprints_scores_gin_idx ON fingerprints USING GIN (scores);

CREATE TABLE IF NOT EXISTS ban_records (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    username TEXT NOT NULL,
    ban_type TEXT NOT NULL,
    permanent BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    reason TEXT NOT NULL,
    detailed_reason TEXT,
    fingerprint_hash TEXT NOT NULL,
    fingerprint_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    scores JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    banned_by TEXT NOT NULL DEFAULT 'SYSTEM',
    moderator_id TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    appealed BOOLEAN NOT NULL DEFAULT false,
    appeal_reason TEXT,
    appealed_at TIMESTAMPTZ,
    webhook_sent BOOLEAN NOT NULL DEFAULT false,
    webhook_sent_at TIMESTAMPTZ,
    history JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ban_records_account_active_idx ON ban_records (account_id, active);
CREATE INDEX IF NOT EXISTS ban_records_hash_active_idx ON ban_records (fingerprint_hash, active);
CREATE INDEX IF NOT EXISTS ban_records_snapshot_gin_idx ON ban_records USING GIN (fingerprint_snapshot);
CREATE INDEX IF NOT EXISTS ban_records_created_at_idx ON ban_records (created_at DESC);
CREATE INDEX IF NOT EXISTS ban_records_expires_at_idx ON ban_records (expires_at);
