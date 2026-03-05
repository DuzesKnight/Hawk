import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

const required = ['BOT_TOKEN', 'CLIENT_ID'];
const optional = [
    'MONGO_URI',
    'LAVALINK_HOST',
    'LAVALINK_PORT',
    'LAVALINK_PASSWORD',
    'LAVALINK_NODES',
    'LAVALINK_ENABLE_LOCAL_FALLBACK',
    'LAVALINK_LOCAL_HOST',
    'LAVALINK_LOCAL_PORT',
    'LAVALINK_LOCAL_PASSWORD',
    'LAVALINK_LOCAL_SECURE',
    'LAVALINK_MANAGE_LOCAL',
    'LAVALINK_JAVA_OPTS',
    'AI_API_KEY',
    'REQUEST_CHANNEL_ID',
    'YOUTUBE_OAUTH_REFRESH_TOKEN',
    'YOUTUBE_PO_TOKEN',
    'YOUTUBE_VISITOR_DATA',
];

function parseLavalinkNodes() {
    const raw = process.env.LAVALINK_NODES;
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .map((node, index) => ({
                name: node?.name || `Node${index + 1}`,
                host: node?.host || '127.0.0.1',
                port: Number(node?.port || 2333),
                password: node?.password || 'youshallnotpass',
                secure: node?.secure === true || node?.secure === 'true',
            }))
            .filter(node => Number.isFinite(node.port) && node.port > 0);
    } catch {
        logger.warn('Invalid LAVALINK_NODES JSON — falling back to single node config');
        return [];
    }
}

export function validateEnv() {
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        logger.fatal(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }

    const unset = optional.filter(key => !process.env[key]);
    if (unset.length > 0) {
        logger.warn(`Optional environment variables not set: ${unset.join(', ')}`);
    }
}

export const config = {
    // Bot
    token: process.env.BOT_TOKEN,
    clientId: process.env.CLIENT_ID,

    // Database
    mongoUri: process.env.MONGO_URI || '',

    // Lavalink
    lavalink: {
        host: process.env.LAVALINK_HOST || '127.0.0.1',
        port: parseInt(process.env.LAVALINK_PORT || '2333', 10),
        password: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: process.env.LAVALINK_SECURE === 'true',
        nodes: parseLavalinkNodes(),
        enableLocalFallback: process.env.LAVALINK_ENABLE_LOCAL_FALLBACK !== 'false',
        local: {
            host: process.env.LAVALINK_LOCAL_HOST || '127.0.0.1',
            port: parseInt(process.env.LAVALINK_LOCAL_PORT || '2333', 10),
            password: process.env.LAVALINK_LOCAL_PASSWORD || process.env.LAVALINK_PASSWORD || 'youshallnotpass',
            secure: process.env.LAVALINK_LOCAL_SECURE === 'true',
            manage: process.env.LAVALINK_MANAGE_LOCAL !== 'false',
        },
        javaOpts: process.env.LAVALINK_JAVA_OPTS || '-Xms512M -Xmx1024M -XX:+UseG1GC -Dsun.zip.disableMemoryMapping=true',
    },

    // Music Sources
    spotify: {
        clientId: process.env.SPOTIFY_CLIENT_ID || '',
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    },
    appleMusicToken: process.env.APPLE_MUSIC_TOKEN || '',
    deezerKey: process.env.DEEZER_DECRYPTION_KEY || '',

    // YouTube Authentication (required for VPS/datacenter IPs)
    youtube: {
        oauthRefreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || '',
        poToken: process.env.YOUTUBE_PO_TOKEN || '',
        visitorData: process.env.YOUTUBE_VISITOR_DATA || '',
    },

    // AI
    aiApiKey: process.env.AI_API_KEY || '',
    aiModel: process.env.AI_MODEL || 'gpt-4o-mini',

    // Channel
    requestChannelId: process.env.REQUEST_CHANNEL_ID || '',

    // Settings
    defaultVolume: parseInt(process.env.DEFAULT_VOLUME || '80', 10),
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '500', 10),
    autoDeleteDelay: parseInt(process.env.AUTO_DELETE_DELAY || '1500', 10),
    embedUpdateInterval: parseInt(process.env.EMBED_UPDATE_INTERVAL || '5000', 10),
};
