/**
 * ═══════════════════════════════════════════════════════════════════
 *  Similarity Engine — Spotify-grade candidate ranking
 * ═══════════════════════════════════════════════════════════════════
 *
 * Implements the scoring formula:
 *
 *   score = 0.40 × mood_similarity
 *         + 0.25 × energy_similarity
 *         + 0.20 × genre_similarity
 *         + 0.10 × tempo_similarity
 *         + 0.05 × popularity_weight
 *
 * This is how Spotify ranks candidates after generating them.
 * We use this to:
 *   1. Score AI-recommended tracks against the seed
 *   2. Re-rank search results to pick the best match
 *   3. Filter out jarring transitions
 *   4. Ensure smooth mood flow in the autoplay queue
 *
 * The engine operates on MoodFeatures objects produced by moodEngine.
 */

import { detectTrackMood, isSmoothTransition } from './moodEngine.js';

// ═══════════════════════════════════════════════════════════════════
//  SCORING WEIGHTS — Spotify's empirical weights
//
//  Mood is the heaviest weight because listeners are most
//  sensitive to mood changes. A sad person doesn't want EDM.
//  Energy is second because it's the physical feeling of music.
//  Genre keeps things in the same sonic space.
//  Tempo prevents jarring BPM shifts.
//  Popularity ensures we recommend songs people can find.
// ═══════════════════════════════════════════════════════════════════

const WEIGHTS = {
    mood:       0.40,
    energy:     0.25,
    genre:      0.20,
    tempo:      0.10,
    popularity: 0.05,
};

// ═══════════════════════════════════════════════════════════════════
//  MOOD SIMILARITY MATRIX
//
//  Not all moods are equally close. "sad" is closer to "romantic"
//  than to "energetic". This matrix captures the relationships.
//  Values are similarity scores (0.0 – 1.0).
// ═══════════════════════════════════════════════════════════════════

const MOOD_SIMILARITY = {
    sad:          { sad: 1.0, romantic: 0.6, chill: 0.5, dark: 0.6, dreamy: 0.5, nostalgic: 0.7, happy: 0.1, energetic: 0.05, aggressive: 0.15, motivational: 0.1 },
    romantic:     { sad: 0.6, romantic: 1.0, chill: 0.7, dark: 0.3, dreamy: 0.8, nostalgic: 0.6, happy: 0.5, energetic: 0.2, aggressive: 0.05, motivational: 0.2 },
    chill:        { sad: 0.5, romantic: 0.7, chill: 1.0, dark: 0.3, dreamy: 0.8, nostalgic: 0.6, happy: 0.5, energetic: 0.2, aggressive: 0.05, motivational: 0.2 },
    happy:        { sad: 0.1, romantic: 0.5, chill: 0.5, dark: 0.05, dreamy: 0.4, nostalgic: 0.5, happy: 1.0, energetic: 0.7, aggressive: 0.1, motivational: 0.7 },
    energetic:    { sad: 0.05, romantic: 0.2, chill: 0.2, dark: 0.3, dreamy: 0.1, nostalgic: 0.2, happy: 0.7, energetic: 1.0, aggressive: 0.6, motivational: 0.7 },
    aggressive:   { sad: 0.15, romantic: 0.05, chill: 0.05, dark: 0.6, dreamy: 0.05, nostalgic: 0.1, happy: 0.1, energetic: 0.6, aggressive: 1.0, motivational: 0.5 },
    nostalgic:    { sad: 0.7, romantic: 0.6, chill: 0.6, dark: 0.3, dreamy: 0.6, nostalgic: 1.0, happy: 0.5, energetic: 0.15, aggressive: 0.1, motivational: 0.3 },
    dark:         { sad: 0.6, romantic: 0.3, chill: 0.3, dark: 1.0, dreamy: 0.4, nostalgic: 0.3, happy: 0.05, energetic: 0.3, aggressive: 0.6, motivational: 0.15 },
    dreamy:       { sad: 0.5, romantic: 0.8, chill: 0.8, dark: 0.4, dreamy: 1.0, nostalgic: 0.6, happy: 0.4, energetic: 0.1, aggressive: 0.05, motivational: 0.15 },
    motivational: { sad: 0.1, romantic: 0.2, chill: 0.2, dark: 0.15, dreamy: 0.15, nostalgic: 0.3, happy: 0.7, energetic: 0.7, aggressive: 0.5, motivational: 1.0 },
};

const TEMPO_MAP = { slow: 0, medium: 1, fast: 2 };

// ═══════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute similarity score between two tracks' mood features.
 *
 * @param {object} seedFeatures - { mood, energy, valence, danceability, tempo, context }
 * @param {object} candidateFeatures - same shape
 * @param {object} options - { sameGenre: boolean, isPopular: boolean }
 * @returns {number} 0.0 – 1.0 similarity score
 */
export function computeSimilarity(seedFeatures, candidateFeatures, options = {}) {
    if (!seedFeatures || !candidateFeatures) return 0.5; // neutral if unknown

    // ── Mood similarity (from matrix) ──
    const moodSim = getMoodSimilarity(seedFeatures.mood, candidateFeatures.mood);

    // ── Energy similarity (absolute difference, inverted) ──
    const energyDiff = Math.abs((seedFeatures.energy || 0.5) - (candidateFeatures.energy || 0.5));
    const energySim = 1.0 - energyDiff;

    // ── Genre similarity (binary + valence/danceability proxy) ──
    let genreSim = 0.5; // default: unknown genre match
    if (options.sameGenre === true) genreSim = 1.0;
    else if (options.sameGenre === false) genreSim = 0.2;
    else {
        // Approximate genre similarity from danceability + valence curves
        const valenceDiff = Math.abs((seedFeatures.valence || 0.5) - (candidateFeatures.valence || 0.5));
        const danceDiff = Math.abs((seedFeatures.danceability || 0.5) - (candidateFeatures.danceability || 0.5));
        genreSim = 1.0 - (valenceDiff * 0.5 + danceDiff * 0.5);
    }

    // ── Tempo similarity ──
    const seedTempo = TEMPO_MAP[seedFeatures.tempo] ?? 1;
    const candTempo = TEMPO_MAP[candidateFeatures.tempo] ?? 1;
    const tempoSim = 1.0 - Math.abs(seedTempo - candTempo) * 0.4;

    // ── Popularity weight ──
    const popWeight = options.isPopular ? 1.0 : 0.5;

    // ── Weighted sum ──
    const score =
        WEIGHTS.mood * moodSim +
        WEIGHTS.energy * energySim +
        WEIGHTS.genre * genreSim +
        WEIGHTS.tempo * tempoSim +
        WEIGHTS.popularity * popWeight;

    return +score.toFixed(3);
}

/**
 * Score a candidate track against a seed track.
 * Convenience wrapper that handles mood detection internally.
 *
 * @param {object} seedTrack - { info: { title, author }, ... }
 * @param {object} candidateTrack - same shape
 * @param {string|null} genre - detected genre
 * @returns {{ score: number, seedMood: object, candidateMood: object }}
 */
export function scoreCandidate(seedTrack, candidateTrack, genre = null) {
    const seedMood = detectTrackMood(seedTrack, genre);
    const candidateMood = detectTrackMood(candidateTrack, genre);

    const score = computeSimilarity(seedMood, candidateMood, {
        sameGenre: undefined, // let it infer from features
    });

    return { score, seedMood, candidateMood };
}

/**
 * Rank an array of candidate tracks against a seed track.
 * Returns tracks sorted by similarity (best first).
 *
 * @param {object} seedTrack - The currently playing track
 * @param {object[]} candidates - Array of resolved track objects
 * @param {string|null} genre - Detected genre string
 * @param {object} options - { filterJarring: boolean, maxResults: number }
 * @returns {object[]} Sorted candidates (best match first)
 */
export function rankCandidates(seedTrack, candidates, genre = null, options = {}) {
    const { filterJarring = true, maxResults = candidates.length } = options;
    const seedMood = detectTrackMood(seedTrack, genre);

    const scored = candidates.map(candidate => {
        const candidateMood = detectTrackMood(candidate, genre);
        const score = computeSimilarity(seedMood, candidateMood);
        const smooth = isSmoothTransition(seedMood.mood, candidateMood.mood);
        return { track: candidate, score, candidateMood, smooth };
    });

    // Filter jarring transitions if requested
    const filtered = filterJarring
        ? scored.filter(s => s.smooth)
        : scored;

    // If filtering removed too many, keep all but penalty-sort
    const pool = filtered.length >= 2 ? filtered : scored;

    // Sort by score (descending)
    pool.sort((a, b) => {
        // Smooth transitions get priority
        if (a.smooth !== b.smooth) return a.smooth ? -1 : 1;
        return b.score - a.score;
    });

    return pool.slice(0, maxResults).map(s => s.track);
}

/**
 * Build a mood summary string for the AI prompt.
 * Gives the AI more context about the current track's vibe.
 *
 * @param {object} track - Track object with info
 * @param {string|null} genre - Detected genre
 * @returns {string} Human-readable mood summary
 */
export function buildMoodSummary(track, genre = null) {
    const features = detectTrackMood(track, genre);
    return `mood=${features.mood} energy=${features.energy} valence=${features.valence} tempo=${features.tempo} context=${features.context}`;
}

/**
 * Build session mood summary for AI context
 */
export function buildSessionMoodSummary(tracks, genres = []) {
    if (!tracks || tracks.length === 0) return '';

    const genre = genres[0] || null;
    let totalEnergy = 0, totalValence = 0;
    const moods = {};

    for (const track of tracks.slice(0, 10)) {
        const f = detectTrackMood(track, genre);
        totalEnergy += f.energy;
        totalValence += f.valence;
        moods[f.mood] = (moods[f.mood] || 0) + 1;
    }

    const n = Math.min(tracks.length, 10);
    const avgEnergy = (totalEnergy / n).toFixed(2);
    const avgValence = (totalValence / n).toFixed(2);
    const dominantMood = Object.entries(moods).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    const moodList = Object.entries(moods).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}(${c})`).join(', ');

    return `SESSION MOOD PROFILE: dominant=${dominantMood} avg_energy=${avgEnergy} avg_valence=${avgValence} moods=[${moodList}]`;
}

// ═══════════════════════════════════════════════════════════════════
//  INTERNAL
// ═══════════════════════════════════════════════════════════════════

function getMoodSimilarity(mood1, mood2) {
    if (!mood1 || !mood2) return 0.5;
    if (mood1 === mood2) return 1.0;
    return MOOD_SIMILARITY[mood1]?.[mood2] ?? 0.3;
}
