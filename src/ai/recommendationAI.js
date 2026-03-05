import OpenAI from 'openai';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { detectTrackMood, getSessionMoodProfile, getAllowedNextMoods } from './moodEngine.js';

let openai = null;

function getClient() {
    if (!openai && config.aiApiKey) {
        openai = new OpenAI({ apiKey: config.aiApiKey });
    }
    return openai;
}

/**
 * ═══════════════════════════════════════════════════════════════════
 *  AI Recommendation Engine v3 — Full Spotify Pipeline
 * ═══════════════════════════════════════════════════════════════════
 *
 * Now integrates with moodEngine + similarityEngine to provide:
 *
 *  1. LOCAL MOOD DETECTION — Before calling AI, we analyze the seed
 *     track's mood/energy/valence/tempo locally using NLP. This data
 *     is passed TO the AI, giving it precise audio feature context.
 *
 *  2. SESSION MOOD PROFILE — We compute the average mood across the
 *     entire listening session, so the AI knows the user's current
 *     emotional state, not just one song.
 *
 *  3. MOOD TRANSITION CONSTRAINTS — We tell the AI which moods are
 *     acceptable next, based on smooth transition rules. This prevents
 *     jarring jumps like sad → party EDM.
 *
 *  4. STRUCTURED OUTPUT — AI returns detailed analysis with mood tags,
 *     which we can then use for post-processing and re-ranking.
 *
 * Pipeline:
 *   Input track → moodEngine.detectMood() → build AI context
 *   → AI generates candidates with mood-awareness
 *   → similarityEngine.rankCandidates() filters after resolution
 */

// ── Artist → scene knowledge for profiling + lang detection ────
const SCENE_KNOWLEDGE = new Map([
    ['arijit singh',     { lang: 'Hindi', scene: 'Bollywood romantic' }],
    ['atif aslam',       { lang: 'Hindi/Urdu', scene: 'Bollywood romantic' }],
    ['shreya ghoshal',   { lang: 'Hindi', scene: 'Bollywood classical' }],
    ['a.r. rahman',      { lang: 'Hindi/Tamil', scene: 'Bollywood orchestral' }],
    ['pritam',           { lang: 'Hindi', scene: 'Bollywood pop' }],
    ['neha kakkar',      { lang: 'Hindi', scene: 'Bollywood pop/dance' }],
    ['badshah',          { lang: 'Hindi/Punjabi', scene: 'Desi hip hop' }],
    ['diljit dosanjh',   { lang: 'Punjabi', scene: 'Punjabi pop' }],
    ['ap dhillon',       { lang: 'Punjabi', scene: 'Punjabi pop/hip hop' }],
    ['sidhu moose wala', { lang: 'Punjabi', scene: 'Punjabi hip hop' }],
    ['anirudh',          { lang: 'Tamil', scene: 'Kollywood' }],
    ['yuvan shankar raja', { lang: 'Tamil', scene: 'Kollywood rock' }],
    ['bts',              { lang: 'Korean', scene: 'K-pop' }],
    ['blackpink',        { lang: 'Korean', scene: 'K-pop' }],
    ['stray kids',       { lang: 'Korean', scene: 'K-pop/hip hop' }],
    ['ive',              { lang: 'Korean', scene: 'K-pop' }],
    ['bad bunny',        { lang: 'Spanish', scene: 'Reggaeton/Latin trap' }],
    ['ozuna',            { lang: 'Spanish', scene: 'Reggaeton' }],
    ['rosalía',          { lang: 'Spanish', scene: 'Latin pop/flamenco' }],
    ['burna boy',        { lang: 'English/Yoruba', scene: 'Afrobeats' }],
    ['wizkid',           { lang: 'English/Yoruba', scene: 'Afrobeats' }],
    ['taylor swift',     { lang: 'English', scene: 'Pop/indie folk' }],
    ['the weeknd',       { lang: 'English', scene: 'Dark R&B/synth pop' }],
    ['drake',            { lang: 'English', scene: 'Hip hop/R&B' }],
    ['kendrick lamar',   { lang: 'English', scene: 'Conscious hip hop' }],
    ['travis scott',     { lang: 'English', scene: 'Psychedelic trap' }],
    ['billie eilish',    { lang: 'English', scene: 'Dark pop/alt' }],
    ['olivia rodrigo',   { lang: 'English', scene: 'Pop punk/pop rock' }],
    ['doja cat',         { lang: 'English', scene: 'Pop rap' }],
]);

/**
 * Build a rich listening profile (Spotify's "taste profile")
 * Now includes mood features from moodEngine.
 */
function buildListeningProfile(history, currentTrack) {
    const tracks = [];
    if (currentTrack?.info) tracks.push(currentTrack);
    for (const t of history) {
        if (t?.info) tracks.push(t);
    }
    if (tracks.length === 0) return null;

    const artists = [];
    const artistCounts = {};
    const titles = [];

    for (const t of tracks) {
        const artist = t.info.author;
        if (artist) {
            if (!artistCounts[artist]) {
                artists.push(artist);
                artistCounts[artist] = 0;
            }
            artistCounts[artist]++;
        }
        titles.push(`"${t.info.title}" by ${t.info.author}`);
    }

    const overRepresented = Object.entries(artistCounts)
        .filter(([, c]) => c >= 2)
        .map(([a]) => a);

    // ── Detect language from ALL tracks in session ──
    let detectedLanguage = null;
    const langVotes = {};
    for (const t of tracks) {
        const text = `${t.info.title || ''} ${t.info.author || ''}`;
        const authorLower = (t.info.author || '').toLowerCase();

        for (const [artist, scene] of SCENE_KNOWLEDGE) {
            if (authorLower.includes(artist)) {
                langVotes[scene.lang] = (langVotes[scene.lang] || 0) + 3;
                break;
            }
        }

        const langPatterns = [
            { lang: 'Hindi', re: /[\u0900-\u097F]|bollywood|hindi|desi\b/i },
            { lang: 'Tamil', re: /[\u0B80-\u0BFF]|tamil|kollywood/i },
            { lang: 'Telugu', re: /[\u0C00-\u0C7F]|telugu|tollywood/i },
            { lang: 'Punjabi', re: /[\u0A00-\u0A7F]|punjabi/i },
            { lang: 'Korean', re: /[\uAC00-\uD7AF]|k-?pop|korean/i },
            { lang: 'Japanese', re: /[\u3040-\u30FF]|j-?pop|japanese|anime/i },
            { lang: 'Spanish', re: /reggaet[oó]n|latin\b|spanish|bachata/i },
            { lang: 'Arabic', re: /[\u0600-\u06FF]|arabic/i },
            { lang: 'Portuguese', re: /portuguese|brasileiro|sertanejo/i },
            { lang: 'French', re: /french|français/i },
            { lang: 'Turkish', re: /turkish|türkçe/i },
            { lang: 'Russian', re: /[\u0400-\u04FF]|russian/i },
            { lang: 'Afrobeats', re: /afrobeats|afro\s*pop|amapiano/i },
        ];
        for (const { lang, re } of langPatterns) {
            if (re.test(text)) {
                langVotes[lang] = (langVotes[lang] || 0) + 1;
                break;
            }
        }
    }

    if (Object.keys(langVotes).length > 0) {
        detectedLanguage = Object.entries(langVotes)
            .sort((a, b) => b[1] - a[1])[0][0];
    }

    // ── Detect scene from artist knowledge ──
    let detectedScene = null;
    for (const t of tracks) {
        const authorLower = (t.info.author || '').toLowerCase();
        for (const [artist, scene] of SCENE_KNOWLEDGE) {
            if (authorLower.includes(artist)) {
                detectedScene = scene.scene;
                break;
            }
        }
        if (detectedScene) break;
    }

    // ── NEW: Mood features from moodEngine ──
    const seedMood = currentTrack?.info
        ? detectTrackMood(currentTrack)
        : null;
    const sessionMood = getSessionMoodProfile(tracks);

    return {
        artists,
        artistCounts,
        overRepresented,
        titles,
        trackCount: tracks.length,
        recentArtists: artists.slice(0, 3),
        recentTitles: titles.slice(0, 5),
        detectedLanguage,
        detectedScene,
        seedMood,
        sessionMood,
        tracks, // pass raw tracks for mood summary builder
        currentTrack: currentTrack?.info ? {
            title: currentTrack.info.title,
            author: currentTrack.info.author,
        } : null,
    };
}

/**
 * Main entry — get AI recommendations, fall back to local
 */
export async function getSmartRecommendations(history, currentTrack, count = 8) {
    const profile = buildListeningProfile(history, currentTrack);
    if (!profile) return [];

    const client = getClient();

    if (client) {
        try {
            const aiResults = await getAIRecommendations(client, profile, count);
            if (aiResults.length >= Math.ceil(count / 2)) {
                return aiResults;
            }
            const localResults = getLocalRecommendations(profile, count - aiResults.length);
            return [...aiResults, ...localResults].slice(0, count);
        } catch (err) {
            logger.debug(`AI recommendation failed, using local: ${err.message}`);
        }
    }

    return getLocalRecommendations(profile, count);
}

/**
 * ═══════════════════════════════════════════════════════════════════
 *  AI RECOMMENDATIONS — Full Spotify pipeline with mood awareness
 *
 *  The AI now receives:
 *  - Mood features from our local NLP engine (energy, valence, etc.)
 *  - Session mood profile (average across all played tracks)
 *  - Allowed mood transitions (prevents jarring jumps)
 *  - Detailed scoring formula it should follow
 *
 *  The AI performs the full Spotify pipeline internally:
 *  1. Analyze seed track DNA (with our provided features as hints)
 *  2. Map artist graph neighborhood
 *  3. Generate candidates matching mood + energy + language
 *  4. Score using the weighted similarity formula
 *  5. Sequence for natural flow with mood transition smoothing
 * ═══════════════════════════════════════════════════════════════════
 */
async function getAIRecommendations(client, profile, count) {
    const playedTitles = profile.titles.slice(-20);

    // ── Seed track info ──
    const seedInfo = profile.currentTrack
        ? `SEED TRACK: "${profile.currentTrack.title}" by ${profile.currentTrack.author}`
        : 'SEED: Unknown';

    // ── LOCAL MOOD ANALYSIS (from our NLP engine) ──
    // This gives the AI precise audio feature context it wouldn't have otherwise
    let moodBlock = '';
    if (profile.seedMood) {
        const m = profile.seedMood;
        moodBlock = `
OUR AUDIO ANALYSIS OF SEED TRACK:
  mood: ${m.mood}
  energy: ${m.energy} (0=calm, 1=intense)
  valence: ${m.valence} (0=sad, 1=happy)
  danceability: ${m.danceability}
  tempo: ${m.tempo}
  context: ${m.context}`;
    }

    // ── SESSION MOOD PROFILE ──
    let sessionBlock = '';
    if (profile.sessionMood) {
        const s = profile.sessionMood;
        sessionBlock = `
SESSION MOOD PROFILE (averaged across ${profile.trackCount} tracks):
  dominant_mood: ${s.mood}
  avg_energy: ${s.energy}
  avg_valence: ${s.valence}
  mood_distribution: ${JSON.stringify(s.moodDistribution)}`;
    }

    // ── MOOD TRANSITION CONSTRAINTS ──
    let transitionBlock = '';
    if (profile.seedMood) {
        const allowed = getAllowedNextMoods(profile.seedMood.mood);
        transitionBlock = `
MOOD TRANSITION RULES (Spotify's mood smoothing):
  Current mood: ${profile.seedMood.mood}
  Allowed next moods: [${allowed.join(', ')}]
  ⚠️ Do NOT recommend songs with moods outside this list. This prevents jarring transitions like sad→party.`;
    }

    // ── Language enforcement ──
    const langBlock = profile.detectedLanguage
        ? `\nDETECTED LANGUAGE: ${profile.detectedLanguage}\n⚠️ CRITICAL: ALL recommendations MUST be in ${profile.detectedLanguage}. The listener is in a ${profile.detectedLanguage}-language session. Do NOT switch to English unless the session is in English. This is the #1 priority.`
        : '';

    const sceneBlock = profile.detectedScene
        ? `\nDETECTED SCENE: ${profile.detectedScene}`
        : '';

    const cooldownBlock = profile.overRepresented.length > 0
        ? `\nARTIST COOLDOWN: Do NOT recommend songs by: ${profile.overRepresented.join(', ')} (overplayed in session)`
        : '';

    const systemPrompt = `You are a Spotify-grade music recommendation engine. You replicate Spotify's Song Radio algorithm to generate a perfect autoplay queue.

You will be given the currently playing song PLUS our local audio analysis of that song (mood, energy, valence, tempo). Use this data as ground truth for your recommendations.

YOUR PIPELINE (follow exactly):

STEP 1 — SEED DNA ANALYSIS:
Use the provided audio features as a baseline. Refine with your music knowledge:
- Genre & subgenre (be VERY specific: "Punjabi hip hop" not "pop")
- Verify mood matches the audio features we detected
- Note language and regional scene (NON-NEGOTIABLE: Hindi stays Hindi, Korean stays Korean)

STEP 2 — CANDIDATE SCORING:
For each candidate song, mentally compute:
  score = 0.40 × mood_similarity
        + 0.25 × energy_similarity
        + 0.20 × genre_similarity
        + 0.10 × tempo_similarity
        + 0.05 × popularity_weight

Only recommend songs with score > 0.6

STEP 3 — MOOD TRANSITION SMOOTHING:
- Check that each recommended song's mood is in the ALLOWED list
- Energy should stay within ±0.2 of the seed track
- Flow: sad→chill→hopeful is OK. sad→party EDM is NOT OK.
- Maintain emotional thread for 3-4 songs before any gentle shift

STEP 4 — DIVERSITY & SEQUENCING:
- Mix: 40% safe picks (fans always like), 35% discovery, 25% deep cuts
- Never 2 songs by the same artist in a row
- Order for smooth energy transitions

OUTPUT RULES:
- Every song must be REAL and findable on YouTube AND Spotify
- Format: ["Artist - Song Title", ...]
- Return ONLY the JSON array, nothing else`;

    const userPrompt = `${seedInfo}
${moodBlock}${sessionBlock}${transitionBlock}${langBlock}${sceneBlock}${cooldownBlock}

LISTENING SESSION (most recent first):
${playedTitles.join('\n')}

Generate exactly ${count} recommendations. Output ONLY a JSON array:`;

    const response = await client.chat.completions.create({
        model: config.aiModel,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.55,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return [];

    // Parse — handle markdown fences, stray text before/after JSON
    let jsonStr = text;
    jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        jsonStr = arrayMatch[0];
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        logger.debug(`AI returned unparseable response: ${text.substring(0, 200)}`);
        return [];
    }

    if (!Array.isArray(parsed)) return [];

    // Filter and validate
    const playedLower = new Set(playedTitles.map(t => t.toLowerCase()));
    const cleaned = parsed
        .filter(s => typeof s === 'string' && s.length > 3 && s.length < 200)
        .filter(s => s.includes('-') || s.includes('–') || s.includes('—'))
        .filter(s => {
            const lower = s.toLowerCase();
            const songPart = lower.split(/\s*[-–—]\s*/).slice(1).join(' ').trim();
            return !playedLower.has(lower) &&
                   !playedTitles.some(p => songPart && songPart.length > 3 && p.toLowerCase().includes(songPart));
        })
        .slice(0, count);

    if (cleaned.length > 0) {
        logger.info(`AI recommends ${cleaned.length}: ${cleaned.slice(0, 3).join(', ')}${cleaned.length > 3 ? '...' : ''}`);
    }
    return cleaned;
}

/**
 * ═══════════════════════════════════════════════════════════════════
 *  LOCAL ALGORITHM (no AI) — Mood-aware search queries
 *
 *  Uses moodEngine data to build targeted queries.
 *  Queries are structured to trigger platform recommendation
 *  engines (YouTube "related", Spotify "radio") using mood context.
 * ═══════════════════════════════════════════════════════════════════
 */
function getLocalRecommendations(profile, count) {
    if (!profile || profile.artists.length === 0) return [];

    const queries = [];
    const used = new Set();

    function add(q) {
        const key = q.toLowerCase();
        if (key.length > 3 && !used.has(key)) {
            used.add(key);
            queries.push(q);
        }
    }

    // ── Seed-based queries ──
    if (profile.currentTrack) {
        const { title, author } = profile.currentTrack;
        add(`${author} - ${title}`);
        add(`${author} songs`);
        add(`${author} top tracks`);
    }

    // ── Mood-based queries (NEW — uses moodEngine) ──
    if (profile.seedMood) {
        const mood = profile.seedMood.mood;
        const context = profile.seedMood.context;
        if (profile.detectedLanguage) {
            add(`${mood} ${profile.detectedLanguage} songs`);
            add(`${profile.detectedLanguage} ${context} music`);
        } else {
            add(`${mood} songs`);
            add(`${context} music playlist`);
        }
    }

    // ── Language-scoped discovery ──
    if (profile.detectedLanguage) {
        const lang = profile.detectedLanguage;
        for (const artist of profile.recentArtists.slice(0, 2)) {
            add(`${artist} ${lang} songs`);
        }
        add(`${lang} songs`);
        add(`new ${lang} music`);
        add(`trending ${lang}`);
    }

    // ── Scene-based ──
    if (profile.detectedScene) {
        add(`${profile.detectedScene} songs`);
        add(`${profile.detectedScene} music`);
    }

    // ── Artist similarity ──
    for (const artist of profile.recentArtists.slice(0, 3)) {
        add(`${artist} radio`);
    }

    // ── "Similar to" queries ──
    if (profile.currentTrack) {
        const clean = profile.currentTrack.title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
        add(`songs like ${clean}`);
    }

    return queries.sort(() => Math.random() - 0.5).slice(0, count);
}

// ── Legacy exports ─────────────────────────────────────────────
export async function getRecommendations(history, currentTrack) {
    const results = await getSmartRecommendations(history, currentTrack, 1);
    return results[0] || null;
}

export async function getMultipleRecommendations(history, currentTrack, count = 5) {
    return getSmartRecommendations(history, currentTrack, count);
}
