import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@supabase/supabase-js";

// Roles:
//   viewer   - can read applications in their own LGU
//   reviewer - viewer + upload, process, review findings, approve/return (own LGU)
//   admin    - reviewer + can see every LGU
export const ROLES = ["viewer", "reviewer", "admin"];
export const WRITE_ROLES = ["reviewer", "admin"];

// Remembers who is making the current request, so audit entries get the real person.
const userContext = new AsyncLocalStorage();

export function currentActor() {
  return userContext.getStore()?.email ?? "reviewer";
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function createSupabaseAuth({ url, publishableKey, serviceKey }) {
  if (!url || !publishableKey || !serviceKey) {
    throw new Error("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_KEY are all required for login.");
  }
  const publicClient = createClient(url, publishableKey, clientOptions);
  const adminClient = createClient(url, serviceKey, clientOptions);

  async function profileFor(user) {
    const { data, error } = await adminClient
      .from("profiles")
      .select("full_name,role,lgu_id")
      .eq("id", user.id)
      .maybeSingle();
    if (error) throw new Error(`Supabase request failed: ${error.message}`);
    if (!data || !ROLES.includes(data.role) || !data.lgu_id) return null;
    return { id: user.id, email: user.email, full_name: data.full_name, role: data.role, lgu_id: data.lgu_id };
  }

  return {
    // Returns { token, user } or { error } - never throws for a wrong password.
    async login(email, password) {
      const { data, error } = await publicClient.auth.signInWithPassword({ email, password });
      if (error || !data?.session) {
        if (error?.code === "email_not_confirmed") return { error: "This email is not confirmed yet. Confirm it in Supabase (Authentication > Users)." };
        const wrong = !error || error.status === 400 || error.code === "invalid_credentials";
        return { error: wrong ? "Wrong email or password." : "The login service is not available right now. Please try again." };
      }
      const user = await profileFor(data.user);
      if (!user) return { error: "This account has no reviewer profile yet. Ask your administrator." };
      return { token: data.session.access_token, user };
    },
    // Returns the user profile for a valid token, otherwise null.
    async verify(token) {
      const { data, error } = await adminClient.auth.getUser(token);
      if (error || !data?.user) return null;
      return profileFor(data.user);
    },
  };
}

// Express middleware: checks the "Authorization: Bearer <token>" header.
export function authMiddleware(auth) {
  return async (request, response, next) => {
    try {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) return response.status(401).json({ error: "Please sign in." });
      const user = await auth.verify(token);
      if (!user) return response.status(401).json({ error: "Your session ended. Please sign in again." });
      request.user = user;
      return userContext.run(user, () => next());
    } catch (error) {
      return next(error);
    }
  };
}
