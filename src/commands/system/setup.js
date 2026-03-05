import { SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Guild } from '../../database/schemas/Guild.js';
import { createPlayerEmbed, createControlButtons, createExtraButtons } from '../../ui/playerEmbed.js';
import { invalidateChannelCache } from '../../events/messageCreate.js';
import { logger } from '../../utils/logger.js';
import mongoose from 'mongoose';

export const data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create a dedicated music request channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Check if a request channel already exists
        if (mongoose.connection.readyState === 1) {
            const existing = await Guild.findOne({ guildId: interaction.guildId }).lean();
            if (existing?.requestChannelId) {
                const existingCh = interaction.guild.channels.cache.get(existing.requestChannelId);
                if (existingCh) {
                    return interaction.editReply(
                        `⚠️ A music request channel already exists: ${existingCh}\nDelete it first or use \`/setup\` again after removing it.`
                    );
                }
                // Channel was deleted — continue and create a new one
            }
        }

        // Create the request channel
        const channel = await interaction.guild.channels.create({
            name: '🎵│music-requests',
            type: ChannelType.GuildText,
            topic: '� Drop a song name, paste a URL, or use the buttons below to control music. Messages auto-delete.',
            permissionOverwrites: [
                {
                    id: interaction.guild.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageMessages,
                        PermissionFlagsBits.EmbedLinks,
                    ],
                },
            ],
        });

        // Create initial player embed with both button rows
        const queue = client.playerManager.getQueue(interaction.guildId);
        queue.textChannel = channel;
        const embed = createPlayerEmbed(queue, true);
        const row1 = createControlButtons(queue);
        const row2 = createExtraButtons(queue);
        const playerMsg = await channel.send({ embeds: [embed], components: [row1, row2] });
        queue.playerMessageId = playerMsg.id;

        // Send instructions embed — rich and informative
        const instructionEmbed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setAuthor({ name: '🎧 HAWK Music Player' })
            .setDescription([
                '### Welcome to your music command center!',
                '',
                '**How to play music:**',
                '> 🎵 Type a **song name** — e.g. `Blinding Lights`',
                '> 🔗 Paste a **URL** — YouTube, Spotify, SoundCloud, Apple Music',
                '> 📋 Paste a **playlist URL** to queue the whole thing',
                '',
                '**Controls (buttons above):**',
                '> ⏮ Previous  •  ⏸/▶️ Pause/Play  •  ⏭ Skip  •  ⏹ Stop',
                '> 🔁 Loop  •  🤖 Autoplay  •  🔉🔊 Volume  •  📋 Queue',
                '',
                '**Slash commands:**',
                '> `/play` `/skip` `/pause` `/resume` `/queue` `/volume`',
                '> `/loop` `/shuffle` `/autoplay` `/lyrics` `/nowplaying`',
                '',
                '*Your messages auto-delete to keep this channel clean.*',
            ].join('\n'))
            .setFooter({ text: 'Powered by HAWK • YouTube • Spotify • SoundCloud • Apple Music' });
        await channel.send({ embeds: [instructionEmbed] });

        // Save to database
        if (mongoose.connection.readyState === 1) {
            await Guild.findOneAndUpdate(
                { guildId: interaction.guildId },
                {
                    guildId: interaction.guildId,
                    requestChannelId: channel.id,
                    playerMessageId: playerMsg.id,
                },
                { upsert: true, new: true }
            );
            // Invalidate cached channel ID so messageCreate picks up the new channel
            invalidateChannelCache(interaction.guildId);
        }

        await interaction.editReply(`✅ Music request channel created: ${channel}`);
    } catch (err) {
        logger.error(`Setup error: ${err.message}`);
        await interaction.editReply(`❌ Failed to create channel: ${err.message}`);
    }
}
