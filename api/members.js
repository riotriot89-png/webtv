import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KV_KEY = "members_list";
const BOT_SECRET = process.env.BOT_SECRET;

const VALID_ROLES = ["owner", "admin", "support"];

function authCheck(req) {
  return req.headers["x-bot-secret"] === BOT_SECRET;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── GET: trả thẳng data đã lưu ──────────────────────────────────────────
  if (req.method === "GET") {
    const members = (await kv.get(KV_KEY)) || [];
    return res.status(200).json({ members });
  }

  if (!authCheck(req)) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;

  // ── ADD ──────────────────────────────────────────────────────────────────
  if (req.method === "POST" && action === "add") {
    const { discord_id, name, avatar_url, role } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });
    if (!name) return res.status(400).json({ error: "Thiếu name" });
    if (!role || !VALID_ROLES.includes(role))
      return res.status(400).json({ error: "role phải là: owner, admin, hoặc support" });

    const members = (await kv.get(KV_KEY)) || [];
    if (members.find((m) => m.discord_id === discord_id)) {
      return res.status(409).json({ error: "Member đã tồn tại" });
    }

    // position trong nhóm role của mình
    const sameRole = members.filter((m) => m.role === role);
    const newMember = {
      discord_id,
      name,
      avatar_url: avatar_url || null,
      role,
      position: sameRole.length + 1,
    };
    members.push(newMember);
    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, member: newMember });
  }

  // ── UPDATE (sửa tên / ảnh / role) ─────────────────────────────────────────
  if (req.method === "PATCH" && action === "update") {
    const { discord_id, name, avatar_url, role } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });
    if (role && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: "role phải là: owner, admin, hoặc support" });

    const members = (await kv.get(KV_KEY)) || [];
    const idx = members.findIndex((m) => m.discord_id === discord_id);
    if (idx === -1) return res.status(404).json({ error: "Không tìm thấy member" });

    if (name) members[idx].name = name;
    if (avatar_url) members[idx].avatar_url = avatar_url;
    if (role) {
      // đổi role → gán position cuối nhóm mới
      const sameRole = members.filter((m, i) => m.role === role && i !== idx);
      members[idx].role = role;
      members[idx].position = sameRole.length + 1;
    }

    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, member: members[idx] });
  }

  // ── REMOVE ───────────────────────────────────────────────────────────────
  if (req.method === "DELETE" && action === "remove") {
    const { discord_id } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });

    let members = (await kv.get(KV_KEY)) || [];
    const before = members.length;
    const removed = members.find((m) => m.discord_id === discord_id);
    members = members.filter((m) => m.discord_id !== discord_id);
    if (members.length === before) return res.status(404).json({ error: "Không tìm thấy member" });

    // cập nhật lại position trong từng role group
    for (const role of VALID_ROLES) {
      let pos = 1;
      members.filter((m) => m.role === role).forEach((m) => { m.position = pos++; });
    }

    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, remaining: members.length, removed_name: removed?.name });
  }

  // ── REORDER (trong cùng role group) ──────────────────────────────────────
  if (req.method === "POST" && action === "reorder") {
    const { ordered_ids, role } = req.body;
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: "ordered_ids phải là mảng" });
    if (!role || !VALID_ROLES.includes(role))
      return res.status(400).json({ error: "Cần truyền role khi reorder" });

    let members = (await kv.get(KV_KEY)) || [];
    const map = Object.fromEntries(members.filter((m) => m.role === role).map((m) => [m.discord_id, m]));
    const reordered = ordered_ids.filter((id) => map[id]).map((id, i) => ({ ...map[id], position: i + 1 }));
    const others = members.filter((m) => m.role !== role);
    const final = [...others, ...reordered];
    await kv.set(KV_KEY, final);
    return res.status(200).json({ success: true, members: final });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
