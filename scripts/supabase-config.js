// scripts/supabase-config.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://fwrwpjiamedkcekgvffx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3cndwamlhbWVka2Nla2d2ZmZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMjQyMTQsImV4cCI6MjA4NzcwMDIxNH0.9zsbqpcmvbBwts2UVlu9SQ9EhxSEuRnYkAaAY6XIJ9Y";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export { supabase };
