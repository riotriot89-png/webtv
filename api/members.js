// api/members.js
// GET  /api/members        → trả danh sách member hiện tại (website đọc)
// POST /api/members        → thêm member mới (bot gọi)
// DELETE /api/members      → xóa member (bot gọi)
// POST /api/members/reorder → đổi thứ tự (bot gọi)

import { Redis } from "@upstash/redis";
const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KV_KEY = "members_list";
const BOT_SECRET = process.env.BOT_SECRET; // đặt trong Vercel env vars

function authCheck(req) {
  const secret = req.headers["x-bot-secret"];
  return secret === BOT_SECRET;
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── GET: website lấy danh sách ──────────────────────────────────────────
  if (req.method === "GET") {
    const members = (await kv.get(KV_KEY)) || [];
    return res.status(200).json({ members });
  }

  // Mọi method khác cần xác thực bot
  if (!authCheck(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { action } = req.query;

  // ── POST /api/members?action=add ─────────────────────────────────────────
  if (req.method === "POST" && action === "add") {
    const { discord_id, display_name } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });

    // Lấy avatar từ Discord API
    let avatar_url = null;
    try {
      const discordRes = await fetch(
        `https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${discord_id}`,
        {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          },
        }
      );
      if (discordRes.ok) {
        const data = await discordRes.json();
        const name = display_name || data.nick || data.user?.global_name || data.user?.username;
        const avatarHash = data.avatar || data.user?.avatar;
        if (avatarHash) {
          // Guild avatar ưu tiên trước
          if (data.avatar) {
            avatar_url = `https://cdn.discordapp.com/guilds/${process.env.GUILD_ID}/users/${discord_id}/avatars/${data.avatar}.png?size=512`;
          } else {
            avatar_url = `https://cdn.discordapp.com/avatars/${discord_id}/${data.user.avatar}.png?size=512`;
          }
        }

        const members = (await kv.get(KV_KEY)) || [];

        // Kiểm tra trùng
        if (members.find((m) => m.discord_id === discord_id)) {
          return res.status(409).json({ error: "Member đã tồn tại trong danh sách" });
        }

        const newMember = {
          discord_id,
          name,
          avatar_url,
          position: members.length + 1,
        };

        members.push(newMember);
        await kv.set(KV_KEY, members);

        return res.status(200).json({ success: true, member: newMember });
      } else {
        return res.status(404).json({ error: "Không tìm thấy user trong server" });
      }
    } catch (err) {
      return res.status(500).json({ error: "Lỗi khi gọi Discord API", detail: err.message });
    }
  }

  // ── DELETE /api/members?action=remove ────────────────────────────────────
  if (req.method === "DELETE" && action === "remove") {
    const { discord_id } = req.body;
    if (!discord_id) return res.status(400).json({ error: "Thiếu discord_id" });

    let members = (await kv.get(KV_KEY)) || [];
    const before = members.length;
    members = members.filter((m) => m.discord_id !== discord_id);

    if (members.length === before) {
      return res.status(404).json({ error: "Không tìm thấy member này" });
    }

    // Cập nhật lại position
    members.forEach((m, i) => (m.position = i + 1));
    await kv.set(KV_KEY, members);

    return res.status(200).json({ success: true, remaining: members.length });
  }

  // ── POST /api/members?action=reorder ─────────────────────────────────────
  // Body: { ordered_ids: ["discord_id_1", "discord_id_2", ...] }
  if (req.method === "POST" && action === "reorder") {
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) {
      return res.status(400).json({ error: "ordered_ids phải là mảng" });
    }

    let members = (await kv.get(KV_KEY)) || [];
    const map = Object.fromEntries(members.map((m) => [m.discord_id, m]));

    const reordered = ordered_ids
      .filter((id) => map[id])
      .map((id, i) => ({ ...map[id], position: i + 1 }));

    // Giữ lại member không có trong ordered_ids ở cuối
    const leftover = members
      .filter((m) => !ordered_ids.includes(m.discord_id))
      .map((m, i) => ({ ...m, position: reordered.length + i + 1 }));

    const final = [...reordered, ...leftover];
    await kv.set(KV_KEY, final);

    return res.status(200).json({ success: true, members: final });
  }

  // ── POST /api/members?action=list → danh sách cho bot hiển thị ───────────
  if (req.method === "POST" && action === "list") {
    const members = (await kv.get(KV_KEY)) || [];
    return res.status(200).json({ members });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
