// src/voice/blacklist.js

/**
 * Normalizes user blacklist input into an array of clean string identifiers.
 * Supports string arrays, JSON strings, and comma/whitespace-separated strings.
 */
export function parseBlacklist(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map((s) => String(s).replace(/[<@!>]/g, '').trim()).filter(Boolean);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).replace(/[<@!>]/g, '').trim()).filter(Boolean);
      }
    } catch {}
    return trimmed
      .replace(/[<@!>]/g, '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Checks whether a user/member is blacklisted.
 * Matches against Discord snowflake IDs, usernames, tags, or display names.
 *
 * @param {string[]|string} blacklist
 * @param {string} userId
 * @param {object|null} member Discord GuildMember or minimal mock { id, displayName, user: { id, username, tag } }
 * @returns {boolean}
 */
export function isUserBlacklisted(blacklist, userId, member = null) {
  const list = parseBlacklist(blacklist);
  if (list.length === 0) return false;

  const uid = String(userId || '').replace(/[<@!>]/g, '').trim().toLowerCase();

  for (const item of list) {
    const target = item.toLowerCase();
    if (!target) continue;

    // Match directly by userId
    if (uid && uid === target) return true;

    // Match against member attributes if available
    if (member) {
      if (member.id && String(member.id).toLowerCase() === target) return true;
      if (member.user?.id && String(member.user.id).toLowerCase() === target) return true;
      if (member.user?.username && member.user.username.toLowerCase() === target) return true;
      if (member.user?.tag && member.user.tag.toLowerCase() === target) return true;
      if (member.displayName && member.displayName.toLowerCase() === target) return true;
    }
  }

  return false;
}
