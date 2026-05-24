const { MessageEmbed } = require("discord.js");
const User = require("../../../model/user.js");
const functions = require("../../../structs/functions.js");
const config = require("../../../structs/config.js");
const { styleEmbed } = require("../../utils/embedTheme.js");
const { createBan } = require("../../../anticheat/database/bans");
const { getFingerprint } = require("../../../anticheat/database/fingerprints");
const { calculateFingerprintHash } = require("../../../anticheat/scoring/calculator");

module.exports = {
    commandInfo: {
        name: "ban",
        description: "Ban user",
        options: [
            {
                name: "username",
                description: "Target username.",
                required: true,
                type: 3
            },
            {
                name: "duration",
                description: "Duration (e.g., 1h, 2h, 1d, 7d). Leave empty for permanent.",
                required: false,
                type: 3
            },
            {
                name: "reason",
                description: "Reason",
                required: false,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        await interaction.deferReply({ ephemeral: true });

        if (!config.moderators.includes(interaction.user.id)) {
            return interaction.editReply({ content: "You do not have moderator permissions.", ephemeral: true });
        }

        const { options } = interaction;
        const username = options.get("username").value;
        const durationStr = options.get("duration")?.value;
        const reason = options.get("reason")?.value || "No reason provided";

        const targetUser = await User.findOne({ username_lower: username.toLowerCase() });

        if (!targetUser) {
            return interaction.editReply({ content: "The account username you entered does not exist.", ephemeral: true });
        }

        // Vérifier si déjà banni définitivement
        if (targetUser.banned && !targetUser.bannedUntil) {
            return interaction.editReply({ content: "This account is already permanently banned.", ephemeral: true });
        }

        // Calculer la durée du ban
        let bannedUntil = null;
        let durationDisplay = "permanently";

        if (durationStr) {
            const match = durationStr.match(/^(\d+)([hdm])$/);
            if (!match) {
                return interaction.editReply({ content: "Invalid duration format! Use e.g., 1h, 2h, 1d, 7d.", ephemeral: true });
            }

            const amount = parseInt(match[1]);
            const unit = match[2];
            bannedUntil = new Date();

            if (unit === "h") {
                bannedUntil.setHours(bannedUntil.getHours() + amount);
                durationDisplay = `for ${amount} hour(s)`;
            } else if (unit === "d") {
                bannedUntil.setDate(bannedUntil.getDate() + amount);
                durationDisplay = `for ${amount} day(s)`;
            } else if (unit === "m") {
                bannedUntil.setMinutes(bannedUntil.getMinutes() + amount);
                durationDisplay = `for ${amount} minute(s)`;
            }
        }

        // Mettre à jour le user (champs corrects du modèle)
        await targetUser.updateOne({ $set: { banned: true, bannedUntil, banReason: reason } });

        // === CRÉER LE BAN RECORD DANS L'ANTI-CHEAT ===
        try {
            const fingerprint = await getFingerprint(targetUser.accountId);

            if (fingerprint) {
                const fingerprintHash = calculateFingerprintHash(fingerprint.hwid);

                await createBan(targetUser.accountId, targetUser.username, {
                    banType: "MANUAL",
                    reason: "MANUAL_BAN",
                    detailedReason: reason,
                    fingerprintHash,
                    fingerprintSnapshot: {
                        smbiosUuid: fingerprint.hwid.smbiosUuid,
                        diskSerial: fingerprint.hwid.diskSerial,
                        baseboardSerial: fingerprint.hwid.baseboardSerial,
                        machineGuid: fingerprint.hwid.machineGuid,
                        ip: fingerprint.network?.ip,
                        asn: fingerprint.network?.asn
                    },
                    scores: fingerprint.scores,
                    evidence: {
                        flags: fingerprint.flags?.inconsistencies || [],
                        inconsistencies: [],
                        relatedAccounts: [],
                        clusterIds: []
                    },
                    bannedBy: "MODERATOR",
                    moderatorId: interaction.user.id,
                    permanent: !bannedUntil,
                    expiresAt: bannedUntil
                });
            }
        } catch (err) {
            console.error(`Failed to create anti-cheat ban record: ${err.message}`);
        }

        // Expulser le joueur s'il est connecté
        const refreshIdx = global.refreshTokens.findIndex((i) => i.accountId == targetUser.accountId);
        if (refreshIdx !== -1) global.refreshTokens.splice(refreshIdx, 1);

        const accessIdx = global.accessTokens.findIndex((i) => i.accountId == targetUser.accountId);
        if (accessIdx !== -1) {
            global.accessTokens.splice(accessIdx, 1);
            const xmppClient = global.Clients.find((c) => c.accountId == targetUser.accountId);
            if (xmppClient) xmppClient.client.close();
        }

        if (accessIdx !== -1 || refreshIdx !== -1) functions.UpdateTokens();

        // DM au joueur
        let dmStatus = "";
        if (targetUser.discordId) {
            try {
                const discordUser = await interaction.client.users.fetch(targetUser.discordId);
                const banEmbed = styleEmbed(
                    new MessageEmbed()
                        .setTitle("Account Restricted")
                        .setDescription(`Your account **${targetUser.username}** has been banned from **CUBE**.`)
                        .addFields(
                            { name: "Reason", value: reason, inline: true },
                            { name: "Duration", value: durationDisplay, inline: true }
                        )
                        .setTimestamp(),
                    { tone: "danger", section: "Admin Team", authorName: "Account Status" }
                );

                if (bannedUntil) {
                    banEmbed.addField("Expires on", bannedUntil.toUTCString());
                }

                banEmbed.addField("Appeal Status", "If you believe this was a mistake, please contact a moderator directly.");

                await discordUser.send({ embeds: [banEmbed] });
                dmStatus = " (User notified via DM)";
            } catch {
                dmStatus = " (Could not DM user - DMs closed or user not found)";
            }
        } else {
            dmStatus = " (User has no linked Discord ID)";
        }

        interaction.editReply({ content: `Successfully banned **${targetUser.username}** ${durationDisplay}.${dmStatus}`, ephemeral: true });
    }
};
