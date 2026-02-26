-- 1. Global Chat Table
CREATE TABLE global_chat (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_photo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Rooms Table
CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  host TEXT,
  max_players INT DEFAULT 2,
  grid_size INT DEFAULT 5,
  players JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'waiting',
  is_quick_match BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  game_started_at TIMESTAMPTZ,
  game_ended_at TIMESTAMPTZ,
  game_result JSONB,
  game_state JSONB
);

-- 3. Room Chat Table (to replicate child_added listener)
CREATE TABLE room_chat (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
  player TEXT NOT NULL,
  identity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Quick Match Queue Table
CREATE TABLE quick_match_queue (
  id TEXT PRIMARY KEY, -- typically the player's identity or name
  name TEXT NOT NULL,
  status TEXT DEFAULT 'waiting',
  room_code TEXT,
  joined_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Realtime for all of these tables
alter publication supabase_realtime add table global_chat;
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table room_chat;
alter publication supabase_realtime add table quick_match_queue;

-- Set up basic Row Level Security (RLS) to allow public access for now 
-- (This mimics Firebase's read/write true for development)
ALTER TABLE global_chat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Access" ON global_chat FOR ALL USING (true);

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Access" ON rooms FOR ALL USING (true);

ALTER TABLE room_chat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Access" ON room_chat FOR ALL USING (true);

ALTER TABLE quick_match_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Access" ON quick_match_queue FOR ALL USING (true);
