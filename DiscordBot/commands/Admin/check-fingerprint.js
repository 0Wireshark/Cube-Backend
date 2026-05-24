const { MessageEmbed } = require("discord.js");
const Users = require("../../../model/user.js");
const { getFingerprint } = require("../../../anticheat/database/fingerprints");
const { isAccountBanned } = require("../../../anticheat/database/bans");
const config = require("../../../structs/config.js");

module.exports = {
    commandInfo: {
        name: "check-fingerprint",
        description: "Check a user's fingerprint and anti-cheat status",
        options: [
            {
                name: "username",
                description: "Username to check",
                required: true,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        if (!config.moderators.includes(interaction.user.id)) {
            return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const username = interaction.options.get("username").value;

        try {
            const user = await Users.findOne({ username_lower: username.toLowerCase() }).lean();

            if (!user) {
                return interaction.editReply({ content: `User **${username}** not found.` });
            }

            const fingerprint = await getFingerprint(user.accountId);
            const ban = await isAccountBanned(user.accountId);

            const embed = new MessageEmbed()
                .setTitle(`Fingerprint Check: ${user.username}`)
                .setColor(ban ? 0xFF0000 : 0x00FF00)
                .addField("Account ID", user.accountId, true)
                .addField("Discord ID", user.discordId || "N/A", true)
                .addField("Status", ban ? "BANNED" : "Active", true);

            if (fingerprint) {
                embed.addField("Scores",
                    `Trust: ${fingerprint.scores.trust}\n` +
                    `Spoof: ${fingerprint.scores.spoof}\n` +
                    `Evasion: ${fingerprint.scores.evasion}\n` +
                    `Final: ${fingerprint.scores.final}`,
                    true
                );

                const flagList = [];
                if (fingerprint.flags.spoofDetected) flagList.push("Spoof Detected");
                if (fingerprint.flags.vmDetected) flagList.push("VM Detected");
                if (fingerprint.flags.inconsistencies.length > 0) {
                    flagList.push(`${fingerprint.flags.inconsistencies.length} Inconsistencies`);
                }

                embed.addField("Flags", flagList.length > 0 ? flagList.join("\n") : "None", true);

                const hwid = fingerprint.hwid;
                embed.addField("HWID",
                    `SMBIOS: ${hwid.smbiosUuid ? hwid.smbiosUuid.substring(0, 16) + "..." : "N/A"}\n` +
                    `Disk: ${hwid.diskSerial ? hwid.diskSerial.substring(0, 16) + "..." : "N/A"}\n` +
                    `CPU: ${hwid.cpuModel || "N/A"}\n` +
                    `GPU: ${hwid.gpuDevice || "N/A"}`,
                    false
                );

                if (fingerprint.network) {
                    const net = fingerprint.network;
                    const netFlags = [];
                    if (net.isVpn) netFlags.push("VPN");
                    if (net.isDatacenter) netFlags.push("Datacenter");
                    if (net.isTor) netFlags.push("TOR");
                    if (net.isProxy) netFlags.push("Proxy");

                    embed.addField("Network",
                        `IP: ${net.ip || "N/A"}\n` +
                        `ISP: ${net.isp || "N/A"}\n` +
                        `Reputation: ${net.reputation}/100\n` +
                        `Flags: ${netFlags.length > 0 ? netFlags.join(", ") : "None"}`,
                        false
                    );
                }

                embed.addField("History",
                    `First Seen: ${new Date(fingerprint.history.firstSeen).toLocaleDateString()}\n` +
                    `Last Seen: ${new Date(fingerprint.history.lastSeen).toLocaleDateString()}\n` +
                    `Seen Count: ${fingerprint.history.seenCount}\n` +
                    `IP Changes: ${fingerprint.history.ipHistory.length}`,
                    false
                );
            } else {
                embed.addField("Fingerprint", "No fingerprint data available", false);
            }

            if (ban) {
                embed.addField("Ban Info",
                    `Type: ${ban.banType}\n` +
                    `Reason: ${ban.detailedReason || ban.reason}\n` +
                    `Banned: ${new Date(ban.createdAt).toLocaleString()}\n` +
                    `By: ${ban.bannedBy}`,
                    false
                );
            }

            embed.setFooter({ text: "CUBE Anti-Cheat" });
            embed.setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: `An error occurred: ${err.message}` });
        }
    }
};
