/**
 * Hallucination suppression blocklist and pattern matching.
 *
 * Incorporates media artifact blocklists and repetition suppression patterns from Vexa (Apache-2.0):
 * https://github.com/Vexa-ai/vexa
 *
 * Licensed under Apache License, Version 2.0 (compatible with Parley ISC).
 * Copyright (c) Vexa-ai and Parley contributors.
 */

// Phrases that Whisper commonly hallucinates during silence or non-speech background noise.
// Note: Intentionally excludes common conversational backchannel words (e.g. "Yeah.", "Okay.", "No.")
// so legitimate meeting speech is never suppressed.
const EXACT_PHRASES = new Set([
  // English media / YouTube / outro artifacts
  'thanks for watching!',
  'thanks for watching.',
  'thanks for watching',
  "thanks for watching, and i'll see you next time.",
  'thanks for watching, and see you next time.',
  "we'll be right back.",
  'thank you for watching!',
  'thank you for watching.',
  'thank you for watching',
  'thank you so much for watching.',
  'thank you so much for watching!',
  'thank you very much for watching.',
  'thank you for listening.',
  'thank you for your time, and i will see you next time.',
  "thank you for your time, and i'll see you next time.",
  'thank you so much for joining us today, and we will see you next time.',
  "thank you so much for joining us today, and we'll see you next time.",
  'please subscribe to my channel.',
  'please subscribe to the channel.',
  'like and subscribe!',
  'don\'t forget to like and subscribe.',
  'subtitles by the amara.org community',

  // Italian media / subtitle / silence artifacts
  'grazie per la visione',
  'grazie per la visione.',
  'grazie per la visione!',
  'grazie a tutti per la visione',
  'grazie a tutti per la visione.',
  'grazie per l\'attenzione',
  'grazie per l\'attenzione.',
  'grazie per l\'attenzione!',
  'ci vediamo al prossimo video',
  'ci vediamo al prossimo video.',
  'ci vediamo nel prossimo video',
  'ci vediamo nel prossimo video.',
  'al prossimo video',
  'al prossimo video.',
  'al prossimo video!',
  'iscriviti al canale',
  'iscriviti al canale.',
  'iscriviti al canale!',
  'iscriviti al mio canale',
  'iscriviti al mio canale.',
  'lascia un like e iscriviti al canale.',
  'lasciate un like e iscrivetevi al canale.',
  'lasciate un like e iscrivetevi al canale',
  'buona visione',
  'buona visione.',
  'buona visione!',
  'sottotitoli creati dalla comunità amara.org',
  'sottotitoli e revisione a cura di',
  'sottotitoli a cura di',
  'trascrizione a cura di',
  'fine della trasmissione',
  'fine della trasmissione.',

  // Spanish media artifacts (from Vexa)
  '¡gracias por ver el vídeo!',
  '¡gracias por ver el video!',
  'gracias por ver este video.',
  'gracias por ver este video',
  'gracias por ver el video.',
  'gracias por ver el video',
  '¡suscríbete al canal!',
  '¡suscríbete al canal y dale a like!',
  'y eso es todo por hoy.',
  'y eso es todo por hoy, nos vemos en el próximo video, chau.',
  'y nos vemos en el próximo video.',

  // Japanese media artifacts (from Vexa)
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  '次の動画でお会いしましょう',
  'チャンネル登録をお願いします',
  'チャンネル登録よろしくお願いします',
  '高評価とチャンネル登録をお願いします',
  'また次回の動画でお会いしましょう',
  '最後までご視聴いただきありがとうございました',

  // Turkish media artifacts (from Vexa)
  'abone olmayı unutmayın',
  'abone olmayı unutmayınız',
  'beni takip etmeyi unutmayın',
  'izlediğiniz için teşekkür ederim',
  'izlediğiniz için teşekkürler',
  'bir sonraki videoda görüşmek üzere',
  'kanalıma abone olmayı unutmayın',

  // Russian media artifacts (from Vexa)
  'продолжение следует...',
  'продолжение следует',
  'динамичная музыка',
  'спасибо за просмотр',
  'спасибо за просмотр!',
  'подписывайтесь на канал',
]);

// Regex patterns to catch open-ended variants of YouTube / subtitle / credit lines
const PATTERNS = [
  /^\s*(thanks|thank you)\s+for\s+watching\b/i,
  /^\s*subscribe\s+to\s+(my|the)\s+channel\b/i,
  /^\s*don['’]?t\s+forget\s+to\s+like\s+and\s+subscribe\b/i,
  /^\s*subtitles\s+by\s+(the\s+)?amara\.org\b/i,
  /^\s*sottotitoli\s+(creati|a cura di|e revisione)\b/i,
  /\bamara\.org\b/i,
  /^\s*iscrivi(ti|tevi)\s+al\s+canale\b/i,
  /^\s*grazie\s+(a tutti\s+)?per\s+la\s+visione\b/i,
  /^\s*grazie\s+per\s+l['’]attenzione\b/i,
  /^\s*ci\s+vediamo\s+(al|nel)\s+prossimo\s+video\b/i,
  /suscr[íi]bete\s+al\s+canal/i,
  /inscreva-se\s+no\s+canal/i,
  /^\s*(субтитры|субтитрами|добавил субтитры|редактор субтитров|корректор)(\s|$)/i,
  /dimatorzok/i,
  /дима\s*торзок/i,
  /^\s*продолжение следует/i,
  /^\s*спасибо за субтитры/i,
  // Sound effects / Whisper bracketed tokens
  /^\[(music|applause|laughter|silence|whispering|cough|sigh|cheering)\]$/i,
  /^\((music|applause|laughter|silence|whispering|cough|sigh|cheering)\)$/i,
  /^♪.*♪$/,
];

/**
 * Detects whether an utterance consists of an autoregressive repetition loop.
 * E.g. "Thank you very much. Thank you very much. Thank you very much..."
 *
 * Checks if a 1-to-6 word phrase repeats 3+ times and makes up >= 75% of the total tokens.
 */
export function isRepetitionLoop(text) {
  if (!text) return false;
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;

  // Single word repetition (e.g. "grazie grazie grazie grazie")
  if (words.length >= 3) {
    const first = words[0];
    const matchCount = words.filter((w) => w === first).length;
    if (matchCount >= 3 && matchCount / words.length >= 0.75) return true;
  }

  // 2 to 6 word phrase repetition
  for (let len = 2; len <= 6; len++) {
    if (words.length < len * 3) continue;
    const phrase = words.slice(0, len).join(' ');
    let count = 0;
    for (let i = 0; i <= words.length - len; i += len) {
      if (words.slice(i, i + len).join(' ') === phrase) {
        count++;
      } else {
        break; // consecutive sequence starting at prefix
      }
    }
    if (count >= 3 && (count * len) / words.length >= 0.75) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the text is a known Whisper silence hallucination,
 * subtitle watermark, or autoregressive loop.
 */
export function isHallucination(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();

  // 1. Exact match against blocklist
  if (EXACT_PHRASES.has(lower)) return true;

  // 2. Normalized trailing punctuation match
  const stripped = lower.replace(/[.!?…]+$/g, '').trim();
  if (stripped && EXACT_PHRASES.has(stripped)) return true;

  // 3. Regex patterns
  for (const pat of PATTERNS) {
    if (pat.test(trimmed)) return true;
  }

  // 4. Repetition loop detection
  if (isRepetitionLoop(trimmed)) return true;

  return false;
}
