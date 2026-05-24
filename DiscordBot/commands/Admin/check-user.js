const { MessageEmbed } = require("discord.js");
const User = require("../../../model/user.js");
const config = require("../../../structs/config.js");
const { styleEmbed } = require("../../utils/embedTheme.js");

module.exports = {
    commandInfo: {
        name: "lookup",
        description: "lookup a user account.",
        options: [
            {
                name: "query",
                description: "Search by Username, Discord ID, or Account ID.",
                required: true,
                type: 3
            }
        ]
    },
    execute: async (interaction) => {
        try {
            await interaction.deferReply({ ephemeral: true });

            if (!config.moderators.includes(interaction.user.id)) {
                return interaction.editReply({ content: "You do not have moderator permissions.", ephemeral: true });
            }

            const query = interaction.options.get("query")?.value;
            if (!query) return interaction.editReply({ content: "Please provide a search query.", ephemeral: true });

            let targetUser = await User.findOne({
                $or: [
                    { username_lower: query.toLowerCase() },
                    { discordId: query },
                    { accountId: query }
                ]
            });

            if (!targetUser) {
                const mentionMatch = query.match(/^<@!?(\d+)>$/);
                if (mentionMatch) {
                    targetUser = await User.findOne({ discordId: mentionMatch[1] });
                }
            }

            if (!targetUser) {
                return interaction.editReply({ content: `Could not find any user matching: \`${query}\``, ephemeral: true });
            }

            const embed = styleEmbed(
                new MessageEmbed()
                    .setTitle(`Account Lookup • ${targetUser.username}`)
                    .setDescription("Administrative overview for the selected account.")
                    .addFields(
                        { name: "Display Name", value: `\`${targetUser.username}\``, inline: true },
                        { name: "Email", value: `\`${targetUser.email}\``, inline: true },
                        { name: "Account ID", value: `\`${targetUser.accountId}\``, inline: true },
                        { name: "Discord ID", value: targetUser.discordId ? `<@${targetUser.discordId}> (\`${targetUser.discordId}\`)` : "Not Linked", inline: false },
                        { name: "Creation Date", value: `<t:${Math.floor(new Date(targetUser.created).getTime() / 1000)}:R>`, inline: true },
                        { name: "Status", value: targetUser.banned ? "Banned" : "Active", inline: true },
                        { name: "SAC Code", value: targetUser.currentSACCode ? `\`${targetUser.currentSACCode}\`` : "None", inline: true }
                    )
                    .setTimestamp(),
                {
                    tone: targetUser.banned ? "danger" : "success",
                    section: "Administration",
                    authorName: "User Record"
                }
            );

            if (targetUser.banned) {
                embed.addField("Ban Reason", targetUser.banReason || "No reason provided", false);
                if (targetUser.banExpires) {
                    embed.addField("Ban Expires", `<t:${Math.floor(new Date(targetUser.banExpires) / 1000)}:R>`, true);
                } else {
                    embed.addField("Ban Type", "Permanent", true);
                }
            }

            interaction.editReply({ embeds: [embed], ephemeral: true });
        } catch (err) {
            console.error("Error in check-user command:", err);
            if (interaction.deferred) {
                interaction.editReply({ content: "An error occurred while fetching user data.", ephemeral: true });
            } else {
                interaction.reply({ content: "An error occurred while fetching user data.", ephemeral: true });
            }
        }
    }
};
