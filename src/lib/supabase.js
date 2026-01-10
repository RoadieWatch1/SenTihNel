import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://yjnqyzozvrgajavndgbm.supabase.co";
export const SUPABASE_KEY = "sb_publishable_t3KmD3g6zK3c-4cyzGMrQw_carXwjUq";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
