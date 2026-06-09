import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KV_KEY = "members_list";
const BOT_SECRET = process.env.BOT_SECRET;

function authCheck(req) {
  return req.headers["x-bot-secret"] === BOT_SECRET;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── GET: trả thẳng data đã lưu, không fetch Discord ──────────────────────
  if (req.method === "GET") {
    const members = (await kv.get(KV_KEY)) || [];
    return res.status(200).json({ members });
  }

  if (!authCheck(req)) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;

  // ── ADD ──────────────────────────────────────────────────────────────────
  if (req.method === "POST" && action === "add") {
    const { discord_id, name, avatar_url } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });
    if (!name) return res.status(400).json({ error: "Thiếu name" });

    const members = (await kv.get(KV_KEY)) || [];
    if (members.find((m) => m.discord_id === discord_id)) {
      return res.status(409).json({ error: "Member đã tồn tại" });
    }

    const newMember = {
      discord_id,
      name,
      avatar_url: avatar_url || null,
      position: members.length + 1,
    };
    members.push(newMember);
    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, member: newMember });
  }

  // ── UPDATE (sửa tên / ảnh) ────────────────────────────────────────────────
  if (req.method === "PATCH" && action === "update") {
    const { discord_id, name, avatar_url } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });

    const members = (await kv.get(KV_KEY)) || [];
    const idx = members.findIndex((m) => m.discord_id === discord_id);
    if (idx === -1) return res.status(404).json({ error: "Không tìm thấy member" });

    if (name) members[idx].name = name;
    if (avatar_url) members[idx].avatar_url = avatar_url;

    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, member: members[idx] });
  }

  // ── REMOVE ───────────────────────────────────────────────────────────────
  if (req.method === "DELETE" && action === "remove") {
    const { discord_id } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });

    let members = (await kv.get(KV_KEY)) || [];
    const before = members.length;
    members = members.filter((m) => m.discord_id !== discord_id);
    if (members.length === before) return res.status(404).json({ error: "Không tìm thấy member" });

    members.forEach((m, i) => (m.position = i + 1));
    await kv.set(KV_KEY, members);
    return res.status(200).json({ success: true, remaining: members.length });
  }

  // ── REORDER ──────────────────────────────────────────────────────────────
  if (req.method === "POST" && action === "reorder") {
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: "ordered_ids phải là mảng" });

    let members = (await kv.get(KV_KEY)) || [];
    const map = Object.fromEntries(members.map((m) => [m.discord_id, m]));
    const reordered = ordered_ids.filter((id) => map[id]).map((id, i) => ({ ...map[id], position: i + 1 }));
    const leftover = members.filter((m) => !ordered_ids.includes(m.discord_id)).map((m, i) => ({ ...m, position: reordered.length + i + 1 }));
    const final = [...reordered, ...leftover];
    await kv.set(KV_KEY, final);
    return res.status(200).json({ success: true, members: final });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
