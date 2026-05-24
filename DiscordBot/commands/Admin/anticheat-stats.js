const { MessageEmbed } = require("discord.js");
const { getBanStats } = require("../../../anticheat/database/bans");
const { getWebhookStats } = require("../../../anticheat/webhooks/discord");
const Fingerprint = require("../../../model/fingerprint");
const config = require("../../../structs/config.js");

module.exports = {
    commandInfo: {
        name: "anticheat-stats",
        description: "View anti-cheat system statistics"
    },
    execute: async (interaction) => {
        if (!config.moderators.includes(interaction.user.id)) {
            return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const [banStats, totalFingerprints, suspiciousFingerprints, vmDetected, lowTrust] = await Promise.all([
                getBanStats(),
                Fingerprint.countDocuments({}),
                Fingerprint.countDocuments({ "flags.spoofDetected": true }),
                Fingerprint.countDocuments({ "flags.vmDetected": true }),
                Fingerprint.countDocuments({ "scores.trust": { $lt: 30 } })
            ]);

            const webhookStats = getWebhookStats();

            const embed = new MessageEmbed()
                .setTitle("Anti-Cheat Statistics")
                .setColor(0x00AAFF)
                .addField("Bans",
                    `Total: ${banStats.total}\n` +
                    `Active: ${banStats.active}\n` +
                    `Evasions: ${banStats.evasions}\n` +
                    `Manual: ${banStats.manual}\n` +
                    `Automatic: ${banStats.automatic}`,
                    true
                )
                .addField("Fingerprints",
                    `Total: ${totalFingerprints}\n` +
                    `Suspicious: ${suspiciousFingerprints}\n` +
                    `VM Detected: ${vmDetected}\n` +
                    `Low Trust: ${lowTrust}`,
                    true
                )
                .addField("Webhooks",
                    `Sent: ${webhookStats.sent}\n` +
                    `Failed: ${webhookStats.failed}\n` +
                    `Batched: ${webhookStats.batched}\n` +
                    `Dropped: ${webhookStats.dropped}\n` +
                    `Queue: ${webhookStats.queueSize}`,
                    true
                )
                .setFooter({ text: "CUBE Anti-Cheat" })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: `An error occurred: ${err.message}` });
        }
    }
};
