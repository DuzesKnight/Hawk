import { config } from './env.js';

function buildNodes() {
  const explicitNodes = config.lavalink.nodes?.length > 0
    ? config.lavalink.nodes
    : [{
      name: 'Primary',
      host: config.lavalink.host,
      port: config.lavalink.port,
      password: config.lavalink.password,
      secure: config.lavalink.secure,
    }];

  const nodes = explicitNodes.map(node => ({
    name: node.name,
    url: `${node.host}:${node.port}`,
    auth: node.password,
    secure: Boolean(node.secure),
  }));

  if (config.lavalink.enableLocalFallback) {
    const localKey = `${config.lavalink.local.host}:${config.lavalink.local.port}`;
    const exists = nodes.some(n => n.url === localKey);

    if (!exists) {
      nodes.push({
        name: 'LocalFallback',
        url: localKey,
        auth: config.lavalink.local.password,
        secure: config.lavalink.local.secure,
      });
    }
  }

  return nodes;
}

export const lavalinkNodes = buildNodes();

/**
 * Build Lavalink application.yml with all plugins.
 * Plugins auto-download on first Lavalink start — zero manual setup.
 *
 * Plugins included:
 *   youtube-plugin  — Enhanced YouTube playback & search
 *   LavaSrc         — Spotify, Apple Music, Deezer, Yandex Music, Tidal
 *   LavaSearch      — Cross-platform search from a single query
 *   LavaLyrics      — Lyrics fetching from multiple providers
 */

function escapeYaml(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSpotifyBlock() {
    if (config.spotify.clientId && config.spotify.clientSecret) {
        return `
    spotify:
      clientId: "${escapeYaml(config.spotify.clientId)}"
      clientSecret: "${escapeYaml(config.spotify.clientSecret)}"
      countryCode: "US"
      playlistLoadLimit: 10
      albumLoadLimit: 10`;
    }
    return `
    spotify:
      clientId: ""
      clientSecret: ""
      countryCode: "US"
      playlistLoadLimit: 10
      albumLoadLimit: 10`;
}

function buildAppleMusicBlock() {
    if (config.appleMusicToken) {
        return `
    applemusic:
      mediaAPIToken: "${escapeYaml(config.appleMusicToken)}"
      countryCode: "US"
      playlistLoadLimit: 10
      albumLoadLimit: 10`;
    }
    return `
    applemusic:
      countryCode: "US"
      playlistLoadLimit: 10
      albumLoadLimit: 10`;
}

function buildDeezerBlock() {
    if (config.deezerKey) {
        return `
    deezer:
      masterDecryptionKey: "${escapeYaml(config.deezerKey)}"`;
    }
    return `
    deezer:
      masterDecryptionKey: ""`;
}

function buildYouTubeBlock() {
    let oauthBlock = '';
    let potBlock = '';

    if (config.youtube.oauthRefreshToken) {
        // User provided a refresh token — use it directly
        oauthBlock = `
    oauth:
      enabled: true
      refreshToken: "${escapeYaml(config.youtube.oauthRefreshToken)}"`;
    } else {
        // Enable OAuth without a token — Lavalink will print a device-code
        // link in the logs on first start. User authenticates once and it works.
        oauthBlock = `
    oauth:
      enabled: true`;
    }

    if (config.youtube.poToken && config.youtube.visitorData) {
        potBlock = `
    pot:
      token: "${escapeYaml(config.youtube.poToken)}"
      visitorData: "${escapeYaml(config.youtube.visitorData)}"`;
    }

    return `
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    clients:
      - MUSIC
      - ANDROID_MUSIC
      - TVHTML5EMBEDDED
      - WEB
      - ANDROID_TESTSUITE${oauthBlock}${potBlock}`;
}

export const lavalinkConfig = `
server:
  port: ${config.lavalink.local.port}
  address: 0.0.0.0

lavalink:
  server:
    password: "${config.lavalink.local.password}"
    sources:
      youtube: false
      bandcamp: true
      soundcloud: true
      twitch: true
      vimeo: true
      http: true
      local: false
    bufferDurationMs: 400
    frameBufferDurationMs: 5000
    youtubePlaylistLoadLimit: 100
    playerUpdateInterval: 5
    youtubeSearchEnabled: true
    soundcloudSearchEnabled: true
    gc-warnings: true

  plugins:
#   ─── Enhanced YouTube (replaces built-in) ───
    - dependency: "dev.lavalink.youtube:youtube-plugin:1.18.0"
      repository: "https://maven.lavalink.dev/releases"

#   ─── LavaSrc: Spotify, Apple Music, Deezer, Yandex, Tidal ───
    - dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.1"
      repository: "https://maven.lavalink.dev/releases"

#   ─── LavaSearch: Cross-platform search ───
    - dependency: "com.github.topi314.lavasearch:lavasearch-plugin:1.0.0"
      repository: "https://maven.lavalink.dev/releases"

#   ─── LavaLyrics: Lyrics from multiple providers ───
    - dependency: "com.github.topi314.lavalyrics:lavalyrics-plugin:1.1.0"
      repository: "https://maven.lavalink.dev/releases"

plugins:
${buildYouTubeBlock()}

  lavasrc:
    providers:
      - 'ytsearch:"{isrc}"'
      - 'ytsearch:{title} {author}'
      - 'scsearch:{title} {author}'
${buildSpotifyBlock()}
${buildAppleMusicBlock()}
${buildDeezerBlock()}
    yandexmusic:
      accessToken: ""
    tidal:
      countryCode: "US"

  lavasearch:
    sources:
      - spotify
      - applemusic
      - deezer
      - youtube
      - soundcloud

  lavalyrics:
    sources:
      - spotify
      - youtube
      - deezer

logging:
  file:
    path: ./logs/

  level:
    root: INFO
    lavalink: INFO

  logback:
    rollingpolicy:
      max-file-size: 25MB
      max-history: 7
`.trim();
